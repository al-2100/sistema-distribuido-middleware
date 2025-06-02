package com.mycompany.cliente.java;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.*;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class Cliente {
    private static String RABBITMQ_HOST;
    private static final String EXCHANGE_NAME = "validation";
    private static int THREAD_POOL_SIZE = 10;
    
    private Connection connection;
    private Channel channel;
    private String replyQueueName;
    private final Map<String, CompletableFuture<String>> pendingResponses = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ExecutorService executorService;
    private Map<String, Object> config;
    
    public Cliente() throws Exception {
        loadConfig();
        executorService = Executors.newFixedThreadPool(THREAD_POOL_SIZE);
        setupRabbitMQ();
    }
    
    @SuppressWarnings("unchecked")
    private void loadConfig() throws Exception {
        try {
            String configContent = new String(Files.readAllBytes(Paths.get("config.json")));
            config = objectMapper.readValue(configContent, Map.class);
            
            Map<String, Object> rabbitmqConfig = (Map<String, Object>) config.get("rabbitmq");
            RABBITMQ_HOST = (String) rabbitmqConfig.get("host");
            
            Map<String, Object> clientConfig = (Map<String, Object>) config.get("client");
            THREAD_POOL_SIZE = (Integer) clientConfig.get("threadPoolSize");
            
            System.out.println("📋 Configuración cargada:");
            System.out.println("   RabbitMQ Host: " + RABBITMQ_HOST);
            System.out.println("   Thread Pool: " + THREAD_POOL_SIZE);
        } catch (Exception e) {
            System.out.println("⚠️  No se pudo cargar config.json, usando valores por defecto");
            RABBITMQ_HOST = "localhost";
            THREAD_POOL_SIZE = 10;
        }
    }
    
    @SuppressWarnings("unchecked")
    private void setupRabbitMQ() throws Exception {
        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost(RABBITMQ_HOST);
        
        if (config != null && config.containsKey("rabbitmq")) {
            Map<String, Object> rabbitmqConfig = (Map<String, Object>) config.get("rabbitmq");
            factory.setUsername((String) rabbitmqConfig.get("username"));
            factory.setPassword((String) rabbitmqConfig.get("password"));
        } else {
            factory.setUsername("admin");
            factory.setPassword("admin123");
        }
        
        // Configuración de reconexión
        factory.setAutomaticRecoveryEnabled(true);
        factory.setNetworkRecoveryInterval(5000);
        
        int maxRetries = 10;
        for (int i = 0; i < maxRetries; i++) {
            try {
                connection = factory.newConnection();
                channel = connection.createChannel();
                
                // Declarar exchange
                channel.exchangeDeclare(EXCHANGE_NAME, "direct", true);
                
                // Crear cola temporal para respuestas
                replyQueueName = channel.queueDeclare().getQueue();
                
                // Configurar consumidor de respuestas
                setupResponseConsumer();
                
                System.out.println("✓ Cliente conectado a RabbitMQ en " + RABBITMQ_HOST);
                break;
            } catch (Exception e) {
                System.out.println("Intento " + (i+1) + "/" + maxRetries + " - Error: " + e.getMessage());
                Thread.sleep(5000);
                if (i == maxRetries - 1) throw e;
            }
        }
    }
    
    private void setupResponseConsumer() throws IOException {
        DeliverCallback deliverCallback = (consumerTag, delivery) -> {
            String correlationId = delivery.getProperties().getCorrelationId();
            CompletableFuture<String> future = pendingResponses.remove(correlationId);
            if (future != null) {
                future.complete(new String(delivery.getBody(), "UTF-8"));
            }
        };
        
        channel.basicConsume(replyQueueName, true, deliverCallback, consumerTag -> {});
    }
    
    public CompletableFuture<String> registrarUsuario(Map<String, Object> userData) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                String correlationId = UUID.randomUUID().toString();
                CompletableFuture<String> responseFuture = new CompletableFuture<>();
                pendingResponses.put(correlationId, responseFuture);
                
                AMQP.BasicProperties props = new AMQP.BasicProperties
                    .Builder()
                    .correlationId(correlationId)
                    .replyTo(replyQueueName)
                    .build();
                
                String message = objectMapper.writeValueAsString(userData);
                
                synchronized (channel) {
                    channel.basicPublish(EXCHANGE_NAME, "check", props, message.getBytes("UTF-8"));
                }
                
                // Esperar respuesta con timeout
                int timeout = 30;
                if (config != null && config.containsKey("client")) {
                    Map<String, Object> clientConfig = (Map<String, Object>) config.get("client");
                    timeout = (Integer) clientConfig.get("timeoutSeconds");
                }
                return responseFuture.get(timeout, TimeUnit.SECONDS);
                
            } catch (TimeoutException e) {
                return "{\"status\":\"error\",\"message\":\"Timeout esperando respuesta\"}";
            } catch (Exception e) {
                return "{\"status\":\"error\",\"message\":\"" + e.getMessage() + "\"}";
            }
        }, executorService);
    }
    
    public void iniciarInterfaz() {
        Scanner scanner = new Scanner(System.in);
        
        while (true) {
            System.out.println("\n╔══════════════════════════════════════╗");
            System.out.println("║     SISTEMA DE REGISTRO DE USUARIOS  ║");
            System.out.println("╠══════════════════════════════════════╣");
            System.out.println("║  1. 📝 Registrar nuevo usuario       ║");
            System.out.println("║  2. 🚀 Prueba de carga (1000 reg)   ║");
            System.out.println("║  3. 📊 Ver estadísticas              ║");
            System.out.println("║  4. 🔍 Buscar usuario por DNI       ║");
            System.out.println("║  5. 🎲 Generar usuario aleatorio    ║");
            System.out.println("║  6. 🚪 Salir                        ║");
            System.out.println("╚══════════════════════════════════════╝");
            System.out.print("Seleccione opción: ");
            
            int opcion = scanner.nextInt();
            scanner.nextLine(); // Limpiar buffer
            
            switch (opcion) {
                case 1:
                    registrarUsuarioManual(scanner);
                    break;
                case 2:
                    ejecutarPruebaCarga();
                    break;
                case 3:
                    mostrarEstadisticas();
                    break;
                case 4:
                    buscarUsuario(scanner);
                    break;
                case 5:
                    generarUsuarioAleatorio();
                    break;
                case 6:
                    cerrarConexiones();
                    return;
                default:
                    System.out.println("❌ Opción inválida");
            }
        }
    }
    
    private void registrarUsuarioManual(Scanner scanner) {
        try {
            System.out.println("\n=== REGISTRO MANUAL DE USUARIO ===");
            Map<String, Object> userData = new HashMap<>();
            
            System.out.print("📝 Nombre: ");
            userData.put("nombre", scanner.nextLine());
            
            System.out.print("📧 Correo: ");
            userData.put("correo", scanner.nextLine());
            
            System.out.print("🔒 Clave: ");
            userData.put("clave", scanner.nextLine());
            
            System.out.print("🆔 DNI (8 dígitos): ");
            String dni = scanner.nextLine();
            if (dni.length() != 8) {
                System.out.println("❌ DNI debe tener 8 dígitos");
                return;
            }
            userData.put("dni", dni);
            
            System.out.print("📱 Teléfono: ");
            userData.put("telefono", scanner.nextLine());
            
            System.out.print("👥 Amigos (DNIs separados por coma, o vacío): ");
            String amigosStr = scanner.nextLine().trim();
            if (!amigosStr.isEmpty()) {
                String[] amigos = amigosStr.split(",");
                List<String> amigosList = new ArrayList<>();
                for (String amigo : amigos) {
                    amigosList.add(amigo.trim());
                }
                userData.put("amigos", amigosList);
            }
            
            System.out.println("\n⏳ Enviando registro...");
            long startTime = System.currentTimeMillis();
            
            CompletableFuture<String> future = registrarUsuario(userData);
            String response = future.get();
            
            long endTime = System.currentTimeMillis();
            
            Map<String, Object> responseMap = objectMapper.readValue(response, Map.class);
            
            if ("success".equals(responseMap.get("status"))) {
                System.out.println("\n✅ " + responseMap.get("message"));
                System.out.println("🆔 ID asignado: " + responseMap.get("user_id"));
                if (responseMap.containsKey("amigos_guardados")) {
                    System.out.println("👥 Amigos vinculados: " + responseMap.get("amigos_guardados"));
                }
            } else {
                System.out.println("\n❌ Error: " + responseMap.get("message"));
            }
            
            System.out.println("⏱️  Tiempo de respuesta: " + (endTime - startTime) + " ms");
            
        } catch (Exception e) {
            System.err.println("❌ Error en registro: " + e.getMessage());
        }
    }
    
    @SuppressWarnings("unchecked")
    private void ejecutarPruebaCarga() {
        System.out.println("\n╔══════════════════════════════════════╗");
        System.out.println("║   PRUEBA DE CARGA - 1000 REGISTROS   ║");
        System.out.println("╚══════════════════════════════════════╝");
        
        GeneradorDatos generador = new GeneradorDatos();
        
        long startTime = System.currentTimeMillis();
        List<CompletableFuture<String>> futures = new ArrayList<>();
        AtomicInteger exitosos = new AtomicInteger(0);
        AtomicInteger fallidos = new AtomicInteger(0);
        AtomicInteger contador = new AtomicInteger(0);
        
        // Barra de progreso
        System.out.print("\n[");
        
        for (int i = 0; i < 1000; i++) {
            Map<String, Object> userData = generador.generarUsuarioAleatorio();
            CompletableFuture<String> future = registrarUsuario(userData)
                .thenApply(response -> {
                    try {
                        Map<String, Object> responseMap = objectMapper.readValue(response, Map.class);
                        if ("success".equals(responseMap.get("status"))) {
                            exitosos.incrementAndGet();
                        } else {
                            fallidos.incrementAndGet();
                        }
                        
                        int progreso = contador.incrementAndGet();
                        if (progreso % 50 == 0) {
                            System.out.print("█");
                            System.out.flush();
                        }
                    } catch (Exception e) {
                        fallidos.incrementAndGet();
                    }
                    return response;
                });
            futures.add(future);
        }
        
        // Esperar a que terminen todos
        CompletableFuture<Void> allFutures = CompletableFuture.allOf(
            futures.toArray(new CompletableFuture[0])
        );
        
        try {
            allFutures.get(5, TimeUnit.MINUTES);
            System.out.println("]");
            
            long endTime = System.currentTimeMillis();
            long totalTime = endTime - startTime;
            
            System.out.println("\n╔══════════════════════════════════════╗");
            System.out.println("║           RESULTADOS FINALES         ║");
            System.out.println("╠══════════════════════════════════════╣");
            System.out.println("║ 📊 Total registros: 1000             ║");
            System.out.printf("║ ✅ Exitosos: %-23d ║\n", exitosos.get());
            System.out.printf("║ ❌ Fallidos: %-23d ║\n", fallidos.get());
            System.out.printf("║ ⏱️  Tiempo total: %-18s ║\n", totalTime + " ms");
            System.out.printf("║ ⚡ Promedio: %-23s ║\n", String.format("%.2f ms/reg", totalTime / 1000.0));
            System.out.printf("║ 📈 TPS: %-28s ║\n", String.format("%.2f reg/s", 1000.0 / (totalTime / 1000.0)));
            System.out.println("╚══════════════════════════════════════╝");
            
            // Análisis de errores
            if (fallidos.get() > 0) {
                System.out.println("\n📋 Análisis de errores:");
                Map<String, Integer> tiposError = new HashMap<>();
                
                for (CompletableFuture<String> future : futures) {
                    try {
                        String response = future.getNow(null);
                        if (response != null) {
                            Map<String, Object> responseMap = objectMapper.readValue(response, Map.class);
                            if ("error".equals(responseMap.get("status"))) {
                                String mensaje = (String) responseMap.get("message");
                                tiposError.merge(mensaje, 1, Integer::sum);
                            }
                        }
                    } catch (Exception ignored) {}
                }
                
                tiposError.entrySet().stream()
                    .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                    .limit(5)
                    .forEach(entry -> System.out.println("   • " + entry.getKey() + ": " + entry.getValue()));
            }
            
        } catch (Exception e) {
            System.err.println("\n❌ Error en prueba de carga: " + e.getMessage());
        }
    }
    
    private void mostrarEstadisticas() {
        System.out.println("\n╔══════════════════════════════════════╗");
        System.out.println("║         ESTADÍSTICAS DEL SISTEMA     ║");
        System.out.println("╠══════════════════════════════════════╣");
        System.out.println("║ 🔌 Estado: Conectado                 ║");
        System.out.println("║ 🖥️  Host: " + String.format("%-26s", RABBITMQ_HOST) + " ║");
        System.out.println("║ 🧵 Threads activos: " + String.format("%-16d", ((ThreadPoolExecutor)executorService).getActiveCount()) + " ║");
        System.out.println("║ 📬 Respuestas pendientes: " + String.format("%-10d", pendingResponses.size()) + " ║");
        System.out.println("╚══════════════════════════════════════╝");
    }
    
    private void buscarUsuario(Scanner scanner) {
        System.out.print("\n🔍 Ingrese DNI a buscar: ");
        String dni = scanner.nextLine();
        
        // Esta funcionalidad requeriría una nueva cola/exchange para consultas
        System.out.println("⚠️  Funcionalidad de búsqueda no implementada en esta versión");
    }
    
    @SuppressWarnings("unchecked")
    private void generarUsuarioAleatorio() {
        GeneradorDatos generador = new GeneradorDatos();
        Map<String, Object> usuario = generador.generarUsuarioAleatorio();
        
        System.out.println("\n🎲 Usuario generado aleatoriamente:");
        System.out.println("   Nombre: " + usuario.get("nombre"));
        System.out.println("   Correo: " + usuario.get("correo"));
        System.out.println("   DNI: " + usuario.get("dni"));
        System.out.println("   Teléfono: " + usuario.get("telefono"));
        if (usuario.containsKey("amigos")) {
            System.out.println("   Amigos: " + usuario.get("amigos"));
        }
        
        System.out.print("\n¿Desea registrar este usuario? (S/N): ");
        Scanner scanner = new Scanner(System.in);
        if (scanner.nextLine().equalsIgnoreCase("S")) {
            try {
                CompletableFuture<String> future = registrarUsuario(usuario);
                String response = future.get();
                Map<String, Object> responseMap = objectMapper.readValue(response, Map.class);
                
                if ("success".equals(responseMap.get("status"))) {
                    System.out.println("✅ " + responseMap.get("message"));
                } else {
                    System.out.println("❌ " + responseMap.get("message"));
                }
            } catch (Exception e) {
                System.err.println("❌ Error: " + e.getMessage());
            }
        }
    }
    
    private void cerrarConexiones() {
        try {
            System.out.println("\n🔌 Cerrando conexiones...");
            executorService.shutdown();
            channel.close();
            connection.close();
            System.out.println("✅ Conexiones cerradas correctamente");
        } catch (Exception e) {
            System.err.println("❌ Error al cerrar conexiones: " + e.getMessage());
        }
    }
    
    public static void main(String[] args) {
        try {
            System.out.println("╔══════════════════════════════════════╗");
            System.out.println("║   CLIENTE DE REGISTRO - SISTEMA      ║");
            System.out.println("║          DISTRIBUIDO v1.0            ║");
            System.out.println("╚══════════════════════════════════════╝");
            
            Cliente cliente = new Cliente();
            
            // Verificar si hay argumentos para modo GUI
            if (args.length > 0 && args[0].equals("--gui")) {
                System.out.println("🖼️  Modo GUI no implementado en esta versión");
                System.out.println("   Usando interfaz de terminal...");
            }
            
            cliente.iniciarInterfaz();
            
        } catch (Exception e) {
            System.err.println("❌ Error fatal: " + e.getMessage());
            e.printStackTrace();
        }
    }
}