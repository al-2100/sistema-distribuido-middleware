const amqp = require('amqplib');
const mysql = require('mysql2/promise');
const fs = require('fs');

class LP2Service {
    constructor() {
        this.channel = null;
        this.connection = null;
        this.rabbitConnection = null;
        this.loadConfig();
        this.init();
    }

    loadConfig() {
        try {
            const configFile = fs.readFileSync('config.json', 'utf8');
            this.config = JSON.parse(configFile);
        } catch (error) {
            console.log('[LP2] Usando configuración por defecto');
            this.config = {
                rabbitmq: {
                    host: 'localhost',
                    port: 5672,
                    username: 'admin',
                    password: 'admin123'
                },
                database: {
                    host: 'mysql-db',
                    port: 3306,
                    database: 'bd2',
                    user: 'root',
                    password: 'mysql123'
                }
            };
        }
        
        // Sobrescribir con variables de entorno si existen
        if (process.env.RABBITMQ_HOST) {
            this.config.rabbitmq.host = process.env.RABBITMQ_HOST;
            console.log(`[LP2] Usando RABBITMQ_HOST de variable de entorno: ${process.env.RABBITMQ_HOST}`);
        }
        
        if (process.env.DB_HOST) {
            this.config.database.host = process.env.DB_HOST;
        }
        
        console.log('[LP2] Configuración:', JSON.stringify(this.config, null, 2));
    }

    async init() {
        try {
            // Primero conectar a la base de datos
            await this.setupDatabase();
            // Luego conectar a RabbitMQ
            await this.setupRabbitMQ();
            // Finalmente empezar a consumir mensajes
            await this.startConsuming();
        } catch (error) {
            console.error('[LP2] Error durante inicialización:', error);
            // Reintentar después de 10 segundos
            setTimeout(() => this.init(), 10000);
        }
    }

    async setupDatabase() {
        const maxRetries = 20;
        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[LP2] Conectando a MySQL (intento ${i+1}/${maxRetries})...`);
                
                this.connection = await mysql.createConnection({
                    host: this.config.database.host,
                    port: this.config.database.port,
                    user: this.config.database.user,
                    password: this.config.database.password,
                    database: this.config.database.database,
                    connectTimeout: 60000,
                    waitForConnections: true
                });
                
                // Verificar conexión
                await this.connection.ping();
                
                console.log('✓ [LP2] Conectado a MySQL');
                await this.createTables();
                return; // Salir del bucle si la conexión es exitosa
                
            } catch (error) {
                console.log(`[LP2] Error MySQL: ${error.message}`);
                if (i === maxRetries - 1) {
                    throw error;
                }
                // Esperar más tiempo en los primeros intentos
                const waitTime = i < 5 ? 10000 : 5000;
                console.log(`[LP2] Esperando ${waitTime/1000} segundos antes de reintentar...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }

    async createTables() {
        try {
            // Crear tabla de DNI
            await this.connection.execute(`
                CREATE TABLE IF NOT EXISTS dni_registro (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    dni VARCHAR(8) UNIQUE NOT NULL,
                    nombre VARCHAR(100) NOT NULL,
                    apellidos VARCHAR(100) NOT NULL,
                    lugar_nacimiento VARCHAR(100),
                    ubigeo VARCHAR(6),
                    direccion VARCHAR(200),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_dni (dni)
                )
            `);
            
            // Insertar datos de prueba
            const testData = [
                ['20453629', 'Juan', 'Pérez García', 'Lima', '150101', 'Av. Principal 123'],
                ['12345678', 'María', 'López Díaz', 'Cusco', '080101', 'Jr. Secundario 456'],
                ['87654321', 'Carlos', 'Rodríguez Soto', 'Arequipa', '040101', 'Calle Tercera 789'],
                ['11111111', 'Ana', 'Martínez Ruiz', 'Trujillo', '130101', 'Av. Libertad 111'],
                ['22222222', 'Luis', 'García López', 'Piura', '200101', 'Calle Mayor 222']
            ];
            
            for (const data of testData) {
                try {
                    await this.connection.execute(
                        'INSERT INTO dni_registro (dni, nombre, apellidos, lugar_nacimiento, ubigeo, direccion) VALUES (?, ?, ?, ?, ?, ?)',
                        data
                    );
                    console.log(`[LP2] ✓ Insertado DNI: ${data[0]}`);
                } catch (error) {
                    if (error.code !== 'ER_DUP_ENTRY') {
                        console.error(`[LP2] Error insertando DNI ${data[0]}:`, error.message);
                    }
                }
            }
            
            console.log('[LP2] ✓ Tabla dni_registro lista');
        } catch (error) {
            console.error('[LP2] Error creando tablas:', error);
            throw error;
        }
    }

    async setupRabbitMQ() {
        const maxRetries = 10;
        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[LP2] Conectando a RabbitMQ en ${this.config.rabbitmq.host}:${this.config.rabbitmq.port}...`);
                
                const url = `amqp://${this.config.rabbitmq.username}:${this.config.rabbitmq.password}@${this.config.rabbitmq.host}:${this.config.rabbitmq.port}`;
                
                this.rabbitConnection = await amqp.connect(url);
                this.channel = await this.rabbitConnection.createChannel();
                
                // Verificar que el canal se creó correctamente
                if (!this.channel) {
                    throw new Error('No se pudo crear el canal de RabbitMQ');
                }
                
                // Manejar desconexiones
                this.rabbitConnection.on('error', (err) => {
                    console.error('[LP2] Error de conexión RabbitMQ:', err);
                });
                
                this.rabbitConnection.on('close', () => {
                    console.log('[LP2] Conexión RabbitMQ cerrada');
                    this.channel = null;
                    setTimeout(() => this.init(), 5000);
                });
                
                // Declarar exchange y colas
                await this.channel.assertExchange('validation', 'direct', { durable: true });
                await this.channel.assertQueue('validate_dni', { durable: true });
                await this.channel.bindQueue('validate_dni', 'validation', 'check');
                
                console.log('✓ [LP2] Conectado a RabbitMQ y canal creado');
                return; // Salir del bucle si la conexión es exitosa
                
            } catch (error) {
                console.log(`[LP2] Error RabbitMQ: ${error.message}`);
                this.channel = null;
                if (i === maxRetries - 1) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async validateDNI(msg) {
        const startTime = Date.now();
        
        try {
            const data = JSON.parse(msg.content.toString());
            console.log(`[LP2] Validando DNI: ${data.dni} para usuario: ${data.nombre}`);
            
            // Validar DNI principal
            const [rows] = await this.connection.execute(
                'SELECT * FROM dni_registro WHERE dni = ?',
                [data.dni]
            );
            
            if (rows.length === 0) {
                console.log(`[LP2] ✗ DNI ${data.dni} NO encontrado`);
                return {
                    status: 'error',
                    message: `DNI ${data.dni} no encontrado en BD2`,
                    processingTime: Date.now() - startTime,
                    correlation_id: msg.properties.correlationId
                };
            }
            
            console.log(`[LP2] ✓ DNI ${data.dni} válido - ${rows[0].nombre} ${rows[0].apellidos}`);
            
            // Validar DNIs de amigos
            const invalidFriends = [];
            const validFriends = [];
            
            if (data.amigos && data.amigos.length > 0) {
                console.log(`[LP2] Validando ${data.amigos.length} amigos...`);
                
                for (const amigoDni of data.amigos) {
                    const [friendRows] = await this.connection.execute(
                        'SELECT nombre, apellidos FROM dni_registro WHERE dni = ?',
                        [amigoDni]
                    );
                    
                    if (friendRows.length === 0) {
                        invalidFriends.push(amigoDni);
                        console.log(`[LP2] ✗ Amigo DNI ${amigoDni} NO encontrado`);
                    } else {
                        validFriends.push({
                            dni: amigoDni,
                            nombre: `${friendRows[0].nombre} ${friendRows[0].apellidos}`
                        });
                        console.log(`[LP2] ✓ Amigo DNI ${amigoDni} válido`);
                    }
                }
            }
            
            if (invalidFriends.length > 0) {
                return {
                    status: 'error',
                    message: `DNIs de amigos no encontrados: ${invalidFriends.join(', ')}`,
                    validFriends: validFriends,
                    invalidFriends: invalidFriends,
                    processingTime: Date.now() - startTime,
                    correlation_id: msg.properties.correlationId
                };
            }
            
            // Si todo es válido, enviar a LP1 para guardar
            console.log(`[LP2] ✓ Todas las validaciones pasaron, enviando a LP1...`);
            
            await this.channel.publish(
                'validation',
                'save',
                Buffer.from(JSON.stringify(data)),
                {
                    correlationId: msg.properties.correlationId,
                    replyTo: msg.properties.replyTo
                }
            );
            
            return {
                status: 'validating',
                message: 'DNI validado, enviando a guardar...',
                validFriends: validFriends,
                processingTime: Date.now() - startTime,
                correlation_id: msg.properties.correlationId
            };
            
        } catch (error) {
            console.error('[LP2] Error validando:', error);
            return {
                status: 'error',
                message: error.message,
                processingTime: Date.now() - startTime,
                correlation_id: msg.properties.correlationId
            };
        }
    }

    async startConsuming() {
        try {
            // Verificar que el canal existe antes de usarlo
            if (!this.channel) {
                throw new Error('Canal de RabbitMQ no inicializado');
            }
            
            // Configurar QoS para procesamiento concurrente
            await this.channel.prefetch(5);
            
            await this.channel.consume('validate_dni', async (msg) => {
                if (msg) {
                    const response = await this.validateDNI(msg);
                    
                    // Solo enviar respuesta si no se está redirigiendo a LP1
                    if (response.status !== 'validating') {
                        this.channel.sendToQueue(
                            msg.properties.replyTo,
                            Buffer.from(JSON.stringify(response)),
                            { correlationId: msg.properties.correlationId }
                        );
                    }
                    
                    this.channel.ack(msg);
                }
            });
            
            console.log('[LP2] 🎧 Escuchando mensajes en cola validate_dni...');
            console.log('[LP2] 💚 Servicio listo y operativo');
            
        } catch (error) {
            console.error('[LP2] Error al iniciar consumo:', error);
            throw error;
        }
    }
}

// Iniciar servicio
console.log('╔════════════════════════════════════════╗');
console.log('║   LP2 Service - JavaScript + MySQL     ║');
console.log('╚════════════════════════════════════════╝');

// Esperar un poco para que Docker inicialice completamente
setTimeout(() => {
    const service = new LP2Service();
    
    // Manejo de señales para cerrar correctamente
    process.on('SIGINT', async () => {
        console.log('\n[LP2] Cerrando conexiones...');
        if (service.connection) {
            await service.connection.end();
        }
        if (service.rabbitConnection) {
            await service.rabbitConnection.close();
        }
        process.exit(0);
    });
}, 2000);

// Mantener el proceso vivo
process.on('uncaughtException', (error) => {
    console.error('[LP2] Error no capturado:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('[LP2] Promesa rechazada:', error);
});