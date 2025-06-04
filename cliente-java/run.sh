#!/bin/bash
echo "🚀 Iniciando cliente Java..."

# Nombre de la red Docker compartida
SHARED_NETWORK="mi_red_compartida"

# Nombre del servicio RabbitMQ en la red compartida
RABBITMQ_SERVICE_HOST="rabbitmq_service"

# Verificar si la red existe, si no, intentar crearla (aunque idealmente se crea una vez)
if ! docker network inspect $SHARED_NETWORK >/dev/null 2>&1; then
    echo "⚠️ Red $SHARED_NETWORK no encontrada. Por favor, créala primero con 'docker network create $SHARED_NETWORK'"
    # exit 1 # Opcional: salir si la red no existe
fi

# Construir la imagen del cliente si no existe (opcional, puedes hacerlo manualmente antes)
# docker build -t cliente-java .

# Verificar si debe ejecutar en modo GUI
if [ "$1" == "--gui" ]; then
    docker run -it --rm \
        --network $SHARED_NETWORK \
        -e RABBITMQ_HOST=$RABBITMQ_SERVICE_HOST \
        -e DISPLAY=$DISPLAY \
        -v /tmp/.X11-unix:/tmp/.X11-unix \
        -v $(pwd)/config.json:/app/config.json \
        cliente-java java -jar app.jar --gui
else
    docker run -it --rm \
        --network $SHARED_NETWORK \
        -e RABBITMQ_HOST=$RABBITMQ_SERVICE_HOST \
        -v $(pwd)/config.json:/app/config.json \
        cliente-java
fi