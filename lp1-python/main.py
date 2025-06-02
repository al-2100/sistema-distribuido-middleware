import pika
import json
import psycopg2
import threading
import time
import os
from datetime import datetime

class LP1Service:
    def __init__(self):
        self.load_config()
        self.setup_database()
        self.setup_rabbitmq()
        
    def load_config(self):
        """Cargar configuración desde archivo"""
        with open('config.json', 'r') as f:
            self.config = json.load(f)
        
        # Sobrescribir con variables de entorno si existen
        if os.getenv('RABBITMQ_HOST'):
            self.config['rabbitmq']['host'] = os.getenv('RABBITMQ_HOST')
            
    def setup_database(self):
        """Configurar conexión a PostgreSQL"""
        max_retries = 10
        for i in range(max_retries):
            try:
                self.conn = psycopg2.connect(
                    host=self.config['database']['host'],
                    port=self.config['database']['port'],
                    database=self.config['database']['database'],
                    user=self.config['database']['user'],
                    password=self.config['database']['password']
                )
                self.conn.autocommit = True
                self.create_tables()
                print(f"✓ [LP1] Conectado a PostgreSQL en {self.config['database']['host']}")
                break
            except Exception as e:
                print(f"[LP1] Intento {i+1}/{max_retries} - Error DB: {e}")
                time.sleep(5)
    
    def create_tables(self):
        """Crear tablas si no existen"""
        cursor = self.conn.cursor()
        
        # Tabla de usuarios
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL,
                correo VARCHAR(100) UNIQUE NOT NULL,
                clave VARCHAR(100) NOT NULL,
                dni VARCHAR(8) UNIQUE NOT NULL,
                telefono VARCHAR(15),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Tabla de amigos
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS amigos (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                amigo_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(usuario_id, amigo_id)
            )
        """)
        
        # Índices para mejorar rendimiento
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_usuarios_dni ON usuarios(dni)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_amigos_usuario ON amigos(usuario_id)")
        
        cursor.close()
        print("[LP1] Tablas creadas/verificadas")
    
    def setup_rabbitmq(self):
        """Configurar conexión a RabbitMQ"""
        max_retries = 10
        for i in range(max_retries):
            try:
                credentials = pika.PlainCredentials(
                    self.config['rabbitmq']['username'],
                    self.config['rabbitmq']['password']
                )
                
                self.connection = pika.BlockingConnection(
                    pika.ConnectionParameters(
                        host=self.config['rabbitmq']['host'],
                        port=self.config['rabbitmq']['port'],
                        credentials=credentials,
                        heartbeat=600,
                        blocked_connection_timeout=300
                    )
                )
                self.channel = self.connection.channel()
                
                # Declarar exchanges y colas
                self.channel.exchange_declare(exchange='validation', exchange_type='direct', durable=True)
                self.channel.queue_declare(queue='save_user', durable=True)
                self.channel.queue_bind(queue='save_user', exchange='validation', routing_key='save')
                
                print(f"✓ [LP1] Conectado a RabbitMQ en {self.config['rabbitmq']['host']}")
                break
            except Exception as e:
                print(f"[LP1] Intento {i+1}/{max_retries} - Error RabbitMQ: {e}")
                time.sleep(5)
    
    def save_user(self, ch, method, properties, body):
        """Guardar usuario en BD1 con manejo de concurrencia"""
        lock = threading.Lock()
        
        try:
            data = json.loads(body)
            print(f"[LP1] Procesando usuario: {data['nombre']} - DNI: {data['dni']}")
            
            with lock:
                cursor = self.conn.cursor()
                
                try:
                    # Iniciar transacción
                    cursor.execute("BEGIN")
                    
                    # Verificar si el usuario ya existe
                    cursor.execute("SELECT id FROM usuarios WHERE dni = %s", (data['dni'],))
                    if cursor.fetchone():
                        raise Exception(f"Usuario con DNI {data['dni']} ya existe")
                    
                    # Insertar usuario
                    cursor.execute("""
                        INSERT INTO usuarios (nombre, correo, clave, dni, telefono)
                        VALUES (%s, %s, %s, %s, %s)
                        RETURNING id
                    """, (data['nombre'], data['correo'], data['clave'], 
                          data['dni'], data['telefono']))
                    
                    user_id = cursor.fetchone()[0]
                    
                    # Guardar amigos si existen
                    amigos_guardados = []
                    if 'amigos' in data and data['amigos']:
                        for amigo_dni in data['amigos']:
                            cursor.execute("SELECT id FROM usuarios WHERE dni = %s", (amigo_dni,))
                            result = cursor.fetchone()
                            if result:
                                cursor.execute("""
                                    INSERT INTO amigos (usuario_id, amigo_id)
                                    VALUES (%s, %s)
                                    ON CONFLICT (usuario_id, amigo_id) DO NOTHING
                                """, (user_id, result[0]))
                                amigos_guardados.append(amigo_dni)
                    
                    # Confirmar transacción
                    cursor.execute("COMMIT")
                    
                    response = {
                        'status': 'success',
                        'message': f'Usuario {data["nombre"]} guardado correctamente',
                        'user_id': user_id,
                        'amigos_guardados': amigos_guardados,
                        'timestamp': datetime.now().isoformat(),
                        'correlation_id': properties.correlation_id
                    }
                    
                except Exception as e:
                    cursor.execute("ROLLBACK")
                    raise e
                finally:
                    cursor.close()
            
            # Enviar respuesta
            ch.basic_publish(
                exchange='',
                routing_key=properties.reply_to,
                properties=pika.BasicProperties(correlation_id=properties.correlation_id),
                body=json.dumps(response)
            )
            
            ch.basic_ack(delivery_tag=method.delivery_tag)
            print(f"[LP1] ✓ Usuario {data['nombre']} guardado exitosamente")
            
        except Exception as e:
            print(f"[LP1] ✗ Error: {e}")
            response = {
                'status': 'error',
                'message': str(e),
                'timestamp': datetime.now().isoformat(),
                'correlation_id': properties.correlation_id
            }
            ch.basic_publish(
                exchange='',
                routing_key=properties.reply_to,
                properties=pika.BasicProperties(correlation_id=properties.correlation_id),
                body=json.dumps(response)
            )
            ch.basic_ack(delivery_tag=method.delivery_tag)
    
    def start_consuming(self):
        """Iniciar consumo de mensajes con manejo de hilos"""
        self.channel.basic_qos(prefetch_count=5)  # Procesar hasta 5 mensajes en paralelo
        self.channel.basic_consume(queue='save_user', on_message_callback=self.save_user)
        
        print("[LP1] 🎧 Esperando mensajes para guardar usuarios...")
        print(f"[LP1] 📊 Configuración: {self.config['rabbitmq']['host']}:{self.config['rabbitmq']['port']}")
        
        try:
            self.channel.start_consuming()
        except KeyboardInterrupt:
            print("\n[LP1] Deteniendo servicio...")
            self.channel.stop_consuming()
            self.connection.close()

if __name__ == "__main__":
    print("=== LP1 Service - Python + PostgreSQL ===")
    service = LP1Service()
    service.start_consuming()