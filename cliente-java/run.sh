#!/bin/bash
echo "🚀 Iniciando cliente..."

# Verificar si debe ejecutar en modo GUI
if [ "$1" == "--gui" ]; then
    docker run -it --rm \
        -e DISPLAY=$DISPLAY \
        -v /tmp/.X11-unix:/tmp/.X11-unix \
        -v $(pwd)/config.json:/app/config.json \
        cliente-java java -jar app.jar --gui
else
    docker run -it --rm \
        -v $(pwd)/config.json:/app/config.json \
        cliente-java
fi