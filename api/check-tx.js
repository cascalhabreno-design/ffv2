/**
 * GET /api/check-tx?transactionId=...
 *
 * Consulta o status da cobrança. Chamado pelo polling da página de PIX
 * a cada 5s. Proxy fino sobre o gateway — nesta fase não há banco de
 * dados, já que a entrega dos diamantes é manual.
 *
 * Resposta 200: { status: 'PENDING' | 'COMPLETED', paidAt? }
 */

const { consultarStatus, GatewayError } = require('../lib/gateway');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const transactionId = String((req.query && req.query.transactionId) || '').trim();
  if (!transactionId) {
    return res.status(400).json({ error: 'transactionId ausente.' });
  }

  try {
    const resultado = await consultarStatus(transactionId);

    // Sem cache: o polling precisa do estado atual a cada chamada.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(resultado);
  } catch (erro) {
    if (erro instanceof GatewayError) {
      console.error(`[check-tx] tx=${transactionId} ${erro.message}`);
      // 502 e não 500: a falha é do gateway. O frontend simplesmente
      // tenta de novo no próximo ciclo.
      return res.status(502).json({ error: 'Não foi possível consultar o pagamento.' });
    }
    console.error('[check-tx] erro inesperado:', erro);
    return res.status(500).json({ error: 'Erro interno.' });
  }
};
