// lp4-typescript/src/client.ts
import * as amqp from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { generarUsuarioAleatorio } from './dataGenerator';


// --- Interfaces y Configuración ---
interface RabbitMQConfig {
    host: string;
    port: number;
    username?: string;
    password?: string;
    exchangeName: string;
}

interface ClientAppConfig {
    timeoutSeconds: number;
}

interface Config {
    rabbitmq: RabbitMQConfig;
    client: ClientAppConfig;
}

let config: Config;
try {
    // __dirname apunta al directorio 'dist' después de la compilación.
    // config.json está un nivel arriba.
    const configPath = path.join(__dirname, '../config.json');
    const configFile = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configFile);
} catch (error) {
    console.warn('⚠️ No se pudo cargar config.json. Usando valores por defecto y/o variables de entorno.', error);
    config = {
        rabbitmq: {
            host: 'rabbitmq_service', // Default si no hay config.json ni ENV
            port: 5672,
            username: 'admin',
            password: 'admin123',
            exchangeName: 'validation',
        },
        client: {
            timeoutSeconds: 60,
        },
    };
}

// Sobrescribir con variables de entorno si están presentes
const RABBITMQ_HOST_FROM_ENV = process.env.RABBITMQ_HOST;
const RABBITMQ_USER_FROM_ENV = process.env.RABBITMQ_USER;
const RABBITMQ_PASS_FROM_ENV = process.env.RABBITMQ_PASS;
const RABBITMQ_PORT_FROM_ENV = process.env.RABBITMQ_PORT;

const rabbitHost = RABBITMQ_HOST_FROM_ENV || config.rabbitmq.host;
const rabbitUser = RABBITMQ_USER_FROM_ENV || config.rabbitmq.username;
const rabbitPass = RABBITMQ_PASS_FROM_ENV || config.rabbitmq.password;
const rabbitPort = RABBITMQ_PORT_FROM_ENV ? parseInt(RABBITMQ_PORT_FROM_ENV, 10) : config.rabbitmq.port;

const RABBITMQ_URL = `amqp://${rabbitUser}:${rabbitPass}@${rabbitHost}:${rabbitPort}`;
const EXCHANGE_NAME = config.rabbitmq.exchangeName;
const TIMEOUT_SECONDS = config.client.timeoutSeconds;

// --- Estado de RabbitMQ ---
let connectionInstance: any = null;
let channelInstance: any = null;
let replyQueueName: string | null = null;
let isExiting = false; // Bandera para controlar el cierre y reintentos

// Mapa para almacenar las promesas de respuesta pendientes { correlationId: { resolve, reject } }
const pendingResponses = new Map<string, { resolve: (value: string) => void, reject: (reason?: any) => void }>();

// --- Funciones de RabbitMQ ---
async function setupRabbitMQ(): Promise<boolean> {
    if (isExiting) return false; // No intentar conectar si la aplicación se está cerrando
    if (connectionInstance && channelInstance) return true; // Ya conectado

    let retries = 5;
    while (retries > 0) {
        let tempConnection: any = null; // ✅ CAMBIADO A any
        try {
            console.log(`[LP4] Intentando conectar a RabbitMQ en ${RABBITMQ_URL}... (Intento ${6 - retries})`);
            tempConnection = await amqp.connect(RABBITMQ_URL); // ✅ SIN type assertion

            const tempChannel = await tempConnection.createChannel(); // ✅ SIN type assertion
            console.log(`[LP4] ✓ Conectado a RabbitMQ en ${rabbitHost}:${rabbitPort}`);

            tempConnection.on('error', (err: Error) => {
                console.error('[LP4] ❌ Error de conexión RabbitMQ:', err.message);
                connectionInstance = null;
                channelInstance = null;
                if (!isExiting) setTimeout(setupRabbitMQ, 5000);
            });
            tempConnection.on('close', () => {
                console.log('[LP4] 🔌 Conexión RabbitMQ cerrada.');
                connectionInstance = null;
                channelInstance = null;
                if (!isExiting) setTimeout(setupRabbitMQ, 5000);
            });

            await tempChannel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
            const replyQueue = await tempChannel.assertQueue('', { exclusive: true, durable: false });
            
            tempChannel.consume(replyQueue.queue, (msg: any) => { // ✅ CAMBIADO A any
                if (msg && msg.properties.correlationId) {
                    const correlationId = msg.properties.correlationId;
                    const promiseCallbacks = pendingResponses.get(correlationId);
                    if (promiseCallbacks) {
                        promiseCallbacks.resolve(msg.content.toString());
                        pendingResponses.delete(correlationId);
                    }
                }
            }, { noAck: true });

            // Si todo fue bien, asignar a las variables globales
            connectionInstance = tempConnection;
            channelInstance = tempChannel;
            replyQueueName = replyQueue.queue;
            return true; // Conexión y setup exitosos

        } catch (error: any) {
            console.error(`[LP4] ❌ Error conectando/configurando RabbitMQ (intento ${6 - retries}/5): ${error.message}`);
            retries--;
            if (tempConnection) {
                await tempConnection.close().catch((e: any) => console.error("[LP4] Error al cerrar conexión temporal en catch:", e));
            }
            if (retries === 0) {
                console.error('[LP4] ❌ No se pudo conectar a RabbitMQ después de varios intentos.');
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false; // No se pudo conectar
}

async function sendRequest(userData: Record<string, any>): Promise<string> {
    if (!channelInstance || !replyQueueName || !connectionInstance) {
        console.warn('[LP4] Conexión RabbitMQ no disponible. Intentando reestablecer...');
        const connected = await setupRabbitMQ();
        if (!connected || !channelInstance || !replyQueueName || !connectionInstance) {
            throw new Error('[LP4] Fallo al reestablecer conexión con RabbitMQ. No se puede enviar la solicitud.');
        }
    }

    const correlationId = uuidv4();
    const message = JSON.stringify(userData);

    return new Promise<string>((resolve, reject) => {
        pendingResponses.set(correlationId, { resolve, reject });
        try {
            // TypeScript ahora sabe que channelInstance no es null aquí debido a la lógica anterior
            channelInstance!.publish(EXCHANGE_NAME, 'check', Buffer.from(message), {
                correlationId: correlationId,
                replyTo: replyQueueName!, // replyQueueName tampoco debería ser null aquí
                persistent: true,
            } as amqp.Options.Publish); // Añadir un cast a Options.Publish si es necesario para el tipo
        } catch (publishError: any) {
            console.error("[LP4] Error al publicar mensaje:", publishError);
            pendingResponses.delete(correlationId);
            reject(publishError);
            return;
        }
        setTimeout(() => {
            if (pendingResponses.has(correlationId)) {
                const promiseCallbacks = pendingResponses.get(correlationId);
                promiseCallbacks?.reject(new Error(`[LP4] Timeout esperando respuesta para ${correlationId}`));
                pendingResponses.delete(correlationId);
            }
        }, TIMEOUT_SECONDS * 1000);
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function askQuestion(query: string): Promise<string> {
    return new Promise((resolve) => rl.question(query, (answer) => resolve(answer.trim())));
}

async function registrarUsuarioManual(): Promise<void> {
    console.log("\n[LP4] === REGISTRO MANUAL DE USUARIO ===");
    const userData: Record<string, any> = {};
    userData.nombre = await askQuestion("📝 Nombre: ");
    userData.correo = await askQuestion("📧 Correo: ");
    userData.clave = await askQuestion("🔒 Clave: ");
    const dni = await askQuestion("🆔 DNI (8 dígitos): ");
    if (dni.length !== 8 || !/^\d+$/.test(dni)) {
        console.log("[LP4] ❌ DNI debe tener 8 dígitos numéricos.");
        return mostrarMenu();
    }
    userData.dni = dni;
    userData.telefono = await askQuestion("📱 Teléfono: ");
    const amigosStr = await askQuestion("👥 Amigos (DNIs separados por coma, o vacío): ");
    if (amigosStr) {
        const amigosArray = amigosStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        const validAmigos: string[] = [];
        let invalidFound = false;
        for (const amigoDni of amigosArray) {
            if (amigoDni.length === 8 && /^\d+$/.test(amigoDni)) {
                validAmigos.push(amigoDni);
            } else { invalidFound = true; }
        }
        if (invalidFound) console.log("[LP4] ⚠️ Algunos DNIs de amigos no eran válidos y fueron omitidos.");
        if (validAmigos.length > 0) userData.amigos = validAmigos;
    }

    try {
        console.log("\n[LP4] ⏳ Enviando registro...");
        const startTime = Date.now();
        const responseJson = await sendRequest(userData);
        const endTime = Date.now();
        try {
            const response = JSON.parse(responseJson);
            if (response.status === 'success') {
                console.log(`\n[LP4] ✅ ${response.message}`);
                if (response.user_id) console.log(`[LP4] 🆔 ID asignado: ${response.user_id}`);
                if (response.amigos_guardados && response.amigos_guardados.length > 0) console.log(`[LP4] 👥 Amigos vinculados: ${response.amigos_guardados.join(', ')}`);
            } else { console.log(`\n[LP4] ❌ Error: ${response.message}`); }
        } catch (parseError) { console.error(`[LP4] ❌ Error parseando JSON: ${parseError}. Recibido:`, responseJson); }
        console.log(`[LP4] ⏱️  Tiempo: ${endTime - startTime} ms`);
    } catch (error: any) { console.error("[LP4] ❌ Error en registro:", error.message); }
    return mostrarMenu();
}

async function ejecutarPruebaDeCarga(): Promise<void> {
    console.log("\n[LP4] === PRUEBA DE CARGA - 1000 REGISTROS ===");
    const numRegistros = 1000;
    let exitosos = 0;
    let fallidos = 0;
    const allPromises: Promise<void>[] = [];
    const startTimeTotal = Date.now();

    console.log("[LP4] Iniciando envío de registros...");
    process.stdout.write("[LP4] Progreso: 0%");

    const concurrencyLimit = 50;
    let activePromises = 0;

    for (let i = 0; i < numRegistros; i++) {
        while (activePromises >= concurrencyLimit) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        activePromises++;
        const userData = generarUsuarioAleatorio();
        const promesa = sendRequest(userData)
            .then(responseJson => {
                try {
                    const response = JSON.parse(responseJson);
                    if (response.status === 'success') exitosos++; else fallidos++;
                } catch (parseError) { fallidos++; }
            })
            .catch(() => { fallidos++; })
            .finally(() => {
                activePromises--;
                const completados = exitosos + fallidos;
                const porcentaje = ((completados / numRegistros) * 100).toFixed(0);
                process.stdout.write(`\r[LP4] Progreso: ${porcentaje}% (${completados}/${numRegistros}) Éxito: ${exitosos}, Fallo: ${fallidos}  `);
            });
        allPromises.push(promesa);
    }
    await Promise.all(allPromises);
    const endTimeTotal = Date.now();
    const tiempoTotalMs = endTimeTotal - startTimeTotal;
    process.stdout.write("\r" + " ".repeat(process.stdout.columns || 80) + "\r"); // Limpiar línea
    console.log('\n\n[LP4] --- Resultados Prueba de Carga ---');
    console.log(`Total de Registros Intentados: ${numRegistros}`);
    console.log(`✅ Exitosos: ${exitosos}`);
    console.log(`❌ Fallidos: ${fallidos}`);
    console.log(`⏱️  Tiempo Total: ${tiempoTotalMs} ms (${(tiempoTotalMs / 1000).toFixed(2)} s)`);
    if (exitosos > 0) {
      console.log(`⚡ Tiempo Promedio por Registro Exitoso: ${(tiempoTotalMs / exitosos).toFixed(2)} ms`);
      if (tiempoTotalMs > 0) {
          console.log(`📈 TPS (Éxitos por Segundo): ${(exitosos / (tiempoTotalMs / 1000)).toFixed(2)} reg/s`);
      }
    } else if (numRegistros > 0) {
        console.log(`⚡ Tiempo Promedio por Registro Intentado: ${(tiempoTotalMs / numRegistros).toFixed(2)} ms`);
    }
    console.log('[LP4] ----------------------------------');
    return mostrarMenu();
}

async function cerrarConexiones(): Promise<void> {
    if (isExiting) return;
    isExiting = true;
    console.log("\n[LP4] 🔌 Cerrando conexiones...");
     try {
        if (rl) rl.close();
    } catch (error) {
        // Ignorar errores, el readline ya puede estar cerrado
    }
    try {
        if (channelInstance) await channelInstance.close();
        if (connectionInstance) await connectionInstance.close();
        console.log("[LP4] ✅ Conexiones cerradas correctamente.");
    } catch (error) { console.error("[LP4] ❌ Error al cerrar conexiones:", error); }
    setTimeout(() => process.exit(0), 200);
}

async function mostrarMenu(): Promise<void> {
    if (isExiting) return;
    console.log("\n╔══════════════════════════════════════╗");
    console.log("║ SISTEMA DE REGISTRO (LP4 - TypeScript) ║");
    console.log("╠══════════════════════════════════════╣");
    console.log("║  1. 📝 Registrar nuevo usuario       ║");
    console.log("║  2. 🚀 Prueba de carga (1000 reg)    ║");
    console.log("║  3. 🚪 Salir                         ║");
    console.log("╚══════════════════════════════════════╝");

    const opcion = await askQuestion("[LP4] Seleccione opción: ");
    switch (opcion) {
        case '1': await registrarUsuarioManual(); break;
        case '2': await ejecutarPruebaDeCarga(); break;
        case '3': await cerrarConexiones(); break;
        default: console.log("[LP4] ❌ Opción inválida."); await mostrarMenu(); break;
    }
}

async function main() {
    console.log("🚀 Iniciando Cliente LP4 (TypeScript)...");
    const connectedSuccessfully = await setupRabbitMQ();

    if (connectedSuccessfully && connectionInstance && channelInstance) {
        await mostrarMenu();
    } else {
        console.error("[LP4] ❌ No se pudo iniciar LP4. Falló la conexión inicial a RabbitMQ.");
        await cerrarConexiones();
    }
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => process.on(signal, async (sig) => {
    if (!isExiting) {
      console.log(`\n[LP4] Recibida señal ${sig}.`);
      await cerrarConexiones();
    }
}));

main().catch(async (err) => {
    console.error("[LP4] ❌ Error fatal en la aplicación:", err);
    await cerrarConexiones();
});