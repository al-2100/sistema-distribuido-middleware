FROM maven:3.8-openjdk-17 AS build

WORKDIR /app
COPY pom.xml .
COPY src ./src

RUN mvn clean package

FROM openjdk:17-jdk-slim

WORKDIR /app

# Instalar dependencias para GUI (opcional)
RUN apt-get update && apt-get install -y \
    libxext6 \
    libxrender1 \
    libxtst6 \
    libxi6 \
    && rm -rf /var/lib/apt/lists/*

# Copiar el JAR
COPY --from=build /app/target/cliente-java-1.0-SNAPSHOT.jar app.jar
COPY config.json .

CMD ["java", "-jar", "app.jar"]