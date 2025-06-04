// lp4-typescript/src/dataGenerator.ts
const nombres = ["Lucia", "Mateo", "Sofia", "Santiago", "Valentina", "Sebastian", "Isabella", "Matias", "Camila", "Nicolas"];
const apellidos = ["Gomez", "Rodriguez", "Diaz", "Perez", "Vargas", "Castro", "Sanchez", "Rojas", "Ortiz", "Silva"];
const dominios = ["example.com", "test.net", "demo.org", "mailservice.io"];
const dnisValidosParaAmigos = ["20453629", "12345678", "87654321", "11111111", "22222222", "33333333", "44444444"];

function getRandomElement<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function generarUsuarioAleatorio(): Record<string, any> {
    const nombre = getRandomElement(nombres);
    const apellido = getRandomElement(apellidos);
    const correo = `${nombre.toLowerCase()}.${apellido.toLowerCase()}${Math.floor(Math.random() * 1000)}@${getRandomElement(dominios)}`;
    const dni = String(Math.floor(10000000 + Math.random() * 90000000));
    const telefono = `9${String(Math.floor(10000000 + Math.random() * 90000000))}`;

    const usuario: Record<string, any> = {
        nombre: `${nombre} ${apellido}`,
        correo: correo,
        clave: `pass${Math.floor(1000 + Math.random() * 9000)}`,
        dni: dni,
        telefono: telefono,
    };

    if (Math.random() < 0.5) {
        const amigos: string[] = [];
        const numAmigos = Math.floor(Math.random() * 3) + 1;
        for (let i = 0; i < numAmigos; i++) {
            let amigoDni;
            do {
                amigoDni = getRandomElement(dnisValidosParaAmigos);
            } while (amigos.includes(amigoDni) || amigoDni === dni);
            amigos.push(amigoDni);
        }
        if (amigos.length > 0) {
            usuario.amigos = amigos;
        }
    }
    return usuario;
}