package com.mycompany.cliente.java;

import java.util.*;

public class GeneradorDatos {
    private final Random random = new Random();
    private final String[] nombres = {"Juan", "Maria", "Carlos", "Ana", "Luis", "Carmen", "Pedro", "Rosa", "Miguel", "Laura"};
    private final String[] apellidos = {"Garcia", "Lopez", "Martinez", "Rodriguez", "Perez", "Gonzalez", "Sanchez", "Ramirez", "Torres", "Flores"};
    private final String[] dominios = {"gmail.com", "hotmail.com", "yahoo.com", "outlook.com"};
    
    // DNIs válidos para pruebas
    private final String[] dnisValidos = {"20453629", "12345678", "87654321", "11111111", "22222222"};
    
    public Map<String, Object> generarUsuarioAleatorio() {
        Map<String, Object> usuario = new HashMap<>();
        
        String nombre = nombres[random.nextInt(nombres.length)];
        String apellido = apellidos[random.nextInt(apellidos.length)];
        
        usuario.put("nombre", nombre + " " + apellido);
        usuario.put("correo", generarCorreo(nombre, apellido));
        usuario.put("clave", generarClave());
        usuario.put("dni", generarDNI());
        usuario.put("telefono", generarTelefono());
        
        // 30% de probabilidad de tener amigos
        if (random.nextDouble() < 0.3) {
            List<String> amigos = new ArrayList<>();
            int numAmigos = random.nextInt(3) + 1;
            for (int i = 0; i < numAmigos; i++) {
                String amigoDni = dnisValidos[random.nextInt(dnisValidos.length)];
                if (!amigos.contains(amigoDni)) {
                    amigos.add(amigoDni);
                }
            }
            usuario.put("amigos", amigos);
        }
        
        return usuario;
    }
    
    private String generarCorreo(String nombre, String apellido) {
        String dominio = dominios[random.nextInt(dominios.length)];
        return nombre.toLowerCase() + "." + apellido.toLowerCase() + 
               random.nextInt(1000) + "@" + dominio;
    }
    
    private String generarClave() {
        return "pass" + (random.nextInt(9000) + 1000);
    }
    
    private String generarDNI() {
        // 70% usa DNI válido, 30% genera uno nuevo
        if (random.nextDouble() < 0.7) {
            return dnisValidos[random.nextInt(dnisValidos.length)];
        }
        return String.valueOf(10000000 + random.nextInt(90000000));
    }
    
    private String generarTelefono() {
        return "9" + (10000000 + random.nextInt(90000000));
    }
}