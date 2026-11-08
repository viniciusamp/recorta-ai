// Ponte com o app nativo do iPhone (quando o Recorta Aí roda dentro dele).
// No navegador comum, isNative é false e nada disso é usado.

const handler =
  typeof window !== 'undefined' &&
  window.webkit &&
  window.webkit.messageHandlers &&
  window.webkit.messageHandlers.recorta;

export const isNative = !!handler;

/** Chama o app nativo. Devolve uma Promise com a resposta. */
export function call(cmd, args = {}) {
  if (!handler) return Promise.reject(new Error('Disponível só no app.'));
  return handler.postMessage({ cmd, ...args });
}
