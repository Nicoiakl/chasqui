// Chasqui/1 — Error del Libro con código HTTP-like (402 saldo, 403 parte, 404 inexistente, 409 estado, 410 vencido).
export class LibroError extends Error {
  constructor(code, message) { super(message); this.name = 'LibroError'; this.code = code; }
}
