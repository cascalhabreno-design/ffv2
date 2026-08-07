/**
 * POST /api/create-pix
 *
 * Cria a cobrança PIX. O frontend envia SKUs e dados do cliente;
 * o VALOR é calculado aqui (ver lib/products.js) — jamais confiar no
 * preço vindo do navegador.
 *
 * Resposta 200: { transactionId, pixCode, status }
 */

const { calcularPedido, PedidoInvalidoError } = require('../lib/products');
const { criarCobranca, GatewayError } = require('../lib/gateway');

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const soDigitos = (valor) => String(valor == null ? '' : valor).replace(/\D/g, '');

/** Valida os dados do cliente conforme exigido pelo gateway. */
function validarCliente(corpo) {
  const nome = String(corpo.nome || '').trim();
  const email = String(corpo.email || '').trim();
  const telefone = soDigitos(corpo.telefone);
  const documento = soDigitos(corpo.cpf);

  if (nome.length < 3) {
    throw new PedidoInvalidoError('Informe seu nome completo.');
  }
  if (!REGEX_EMAIL.test(email)) {
    throw new PedidoInvalidoError('Informe um e-mail válido.');
  }
  // O gateway exige DDD + número.
  if (telefone.length !== 10 && telefone.length !== 11) {
    throw new PedidoInvalidoError('Informe um telefone válido com DDD.');
  }
  // 11 dígitos = CPF, 14 = CNPJ. Sem validação de dígito verificador.
  if (documento.length !== 11 && documento.length !== 14) {
    throw new PedidoInvalidoError('Informe um CPF válido.');
  }

  return { nome, email, telefone, documento };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') {
    try {
      corpo = JSON.parse(corpo);
    } catch {
      return res.status(400).json({ error: 'Corpo da requisição inválido.' });
    }
  }
  if (!corpo || typeof corpo !== 'object') {
    return res.status(400).json({ error: 'Corpo da requisição inválido.' });
  }

  try {
    const cliente = validarCliente(corpo);

    const uid = soDigitos(corpo.uid).slice(0, 20);
    const pedido = calcularPedido({
      denomSku: corpo.denom_sku,
      ofertaSku: corpo.oferta_sku,
      bumpSkus: corpo.bump_skus,
      uid,
    });

    const cobranca = await criarCobranca({
      amountInCents: pedido.amountInCents,
      titulo: pedido.titulo,
      descricao: pedido.descricao,
      cliente,
      utm: typeof corpo.utm === 'string' ? corpo.utm : '',
    });

    // Log de rastreio para a entrega manual. Sem CPF, sem e-mail.
    console.log(
      `[pedido] tx=${cobranca.transactionId} valor=${pedido.amountInCents} uid=${uid || '-'} itens="${pedido.itens.join(' + ')}"`
    );

    // Devolve apenas o necessário ao frontend. A Encrypted URL nunca sai daqui.
    return res.status(200).json({
      transactionId: cobranca.transactionId,
      pixCode: cobranca.pixCode,
      status: cobranca.status,
      amountInCents: pedido.amountInCents,
    });
  } catch (erro) {
    if (erro instanceof PedidoInvalidoError) {
      return res.status(400).json({ error: erro.message });
    }
    if (erro instanceof GatewayError) {
      console.error(`[create-pix] ${erro.message}`);
      // 4xx do gateway (exceto 401) significa dado do cliente recusado — por
      // exemplo CPF inexistente. Repetir nao resolve, entao avisamos o cliente
      // em vez de devolver um erro generico que gera loop de tentativas.
      if (erro.statusHttp >= 400 && erro.statusHttp < 500 && erro.statusHttp !== 401) {
        return res.status(400).json({
          error: 'Confira seu CPF, telefone e e-mail e tente novamente.',
        });
      }
      return res.status(502).json({ error: 'Não foi possível gerar o PIX. Tente novamente.' });
    }
    console.error('[create-pix] erro inesperado:', erro);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
