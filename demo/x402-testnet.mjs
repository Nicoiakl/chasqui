// Nyx5 como SERVIDOR DE RECURSO de x402, cobrando USDC real en una red de pruebas.
//
//   node demo/x402-testnet.mjs <archivo-con-el-pago-firmado.json>
//
// Lo que demuestra: la casa cobra dinero real SIN código de cadena, SIN llaves y SIN custodiar.
// El pagador firma una autorización EIP-3009, un facilitador la difunde y paga el gas, y el dinero
// va del pagador al que cobra, directo. Nosotros anunciamos el precio, preguntamos si la firma
// sirve, hacemos el trabajo y pedimos que se liquide.
//
// El pagador NO se firma aquí a propósito: firmar exige keccak256 y secp256k1 con recuperación,
// que Node no trae, y este repositorio no agrega dependencias. Firmar es del cliente; cobrar, que
// es lo nuestro, no necesita nada.
import fs from 'node:fs';
import * as x402 from '../src/puentes/x402.js';

// Por defecto, red de PRUEBAS. Para producción hay que declararlo a mano, porque un demo que
// mueve dinero real por omisión es un accidente esperando ocurrir.
const REDES = {
  prueba: { red: 'eip155:84532', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', nombre: 'USDC',     facilitador: 'https://x402.org/facilitator' },
  real:   { red: 'eip155:8453',  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', nombre: 'USD Coin', facilitador: 'https://facilitator.payai.network' },
};
// El nombre del token es el dominio EIP-712 del CONTRATO y CAMBIA entre redes: en pruebas es
// "USDC" y en producción "USD Coin". Está leído del contrato, no recordado. Mal puesto, la firma
// del pagador no valida y el error no dice por qué.
const cfg = REDES[process.env.X402_RED === 'real' ? 'real' : 'prueba'];
const FACILITADOR = process.env.X402_FACILITADOR || cfg.facilitador;
const RED = cfg.red;
const USDC = cfg.usdc;
if (cfg.red === REDES.real.red) console.log('*** RED REAL: esto mueve dinero de verdad ***');
const paso = (n, t) => console.log(`\n${n}. ${t}`);

const firmado = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const f = x402.facilitador(FACILITADOR);

paso(1, 'Qué acepta el facilitador (sin credenciales, sin cuenta)');
const sup = await f.soportado();
const kinds = (sup.body.kinds || []).filter((k) => k.network === RED).map((k) => k.scheme);
console.log(`   ${FACILITADOR} → ${sup.status} · en ${RED} acepta: ${kinds.join(', ') || '(nada)'}`);
if (!kinds.includes('exact')) { console.log('   sin `exact` en esta red, no se puede seguir'); process.exit(1); }

paso(2, 'El precio que anuncia la casa (lo que iría en la cabecera del 402)');
const pr = x402.requisitosEvm({
  url: 'https://nyx5.com/x402/demo', amount: Number(firmado.monto), payTo: firmado.cobra,
  network: RED, asset: USDC, tokenName: cfg.nombre, tokenVersion: '2',
  description: 'Prueba de cobro real de Nyx5 en red de pruebas',
});
console.log(`   ${pr.accepts[0].amount} unidades atómicas de USDC = US$${Number(pr.accepts[0].amount) / 1e6}`);
console.log(`   paga a: ${pr.accepts[0].payTo}`);
console.log(`   cabecera PAYMENT-REQUIRED: ${x402.cabeceraRequerido(pr).length} bytes`);

paso(3, 'Llega PAYMENT-SIGNATURE: se comprueba que el cliente aceptó NUESTROS términos');
const pago = firmado.carga;
const nuestro = pr.accepts[0], suyo = pago.accepted;
const calza = ['scheme', 'network', 'amount', 'asset', 'payTo'].every((k) => String(nuestro[k]).toLowerCase() === String(suyo[k]).toLowerCase());
console.log(`   ¿coincide con lo que publicamos? ${calza ? 'sí' : 'NO — se rechaza'}`);
if (!calza) process.exit(1);
console.log(`   clave antirreplay: ${x402.claveDePago(pago)}`);

paso(4, 'Se le pregunta al facilitador si la firma sirve (solo lectura, no mueve nada)');
const v = await f.verificar(pago, nuestro);
console.log(`   isValid: ${v.body.isValid}`);
console.log(`   pagador que el facilitador recuperó de la firma: ${v.body.payer || '(ninguno)'}`);
if (!v.body.isValid) {
  console.log(`   motivo: ${v.body.invalidReason}`);
  const falta = /insufficient|exceeds balance/i.test(JSON.stringify(v.body));
  console.log(falta
    ? '\n   TODO LO DEMÁS FUNCIONA. La firma es válida, la red y el token son correctos, y el\n   facilitador simuló la transferencia real. Sólo falta que la billetera tenga fondos.'
    : '\n   El fallo NO es por fondos: hay algo mal en la firma o en los términos.');
  process.exit(0);
}

paso(5, 'El trabajo se hace ANTES de liquidar, porque este flujo es `authorization`');
console.log('   (aquí iría el recurso que se está vendiendo)');

paso(6, 'Liquidar: el facilitador difunde la transacción y paga el gas');
const s = await f.liquidar(pago, nuestro);
console.log(`   success: ${s.body.success} · transacción: ${s.body.transaction}`);
console.log(`   compruébalo tú mismo: ${cfg.red === REDES.real.red ? 'https://basescan.org' : 'https://sepolia.basescan.org'}/tx/${s.body.transaction}`);
