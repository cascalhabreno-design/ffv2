/**
 * Adapter da DuttyFy — ÚNICO arquivo que conhece o gateway.
 *
 * Numa futura troca de provedor, só este arquivo muda: os handlers em
 * /api falam apenas com criarCobranca() e consultarStatus().
 *
 * Contrato da DuttyFy:
 *  - A Encrypted URL é endpoint E credencial ao mesmo tempo. Só em env var.
 *  - Sem header Authorization, sem API key.
 *  - amount sempre inteiro em centavos.
 *  - POST: retry com backoff 1s/2s/4s, máximo 3 tentativas, apenas em 5xx/rede.
 *  - GET: sem retry, o próximo ciclo de polling cobre a falha.
 */

const TIMEOUT_POST_MS = 15000;
const TIMEOUT_GET_MS = 10000;
const MAX_TENTATIVAS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

/** Falha na comunicação com o gateway — vira HTTP 502. */
class GatewayError extends Error {
  constructor(mensagem, statusHttp) {
    super(mensagem);
    this.name = 'GatewayError';
    this.statusHttp = statusHttp;
  }
}

/** Lê a Encrypted URL do ambiente. Falha cedo e alto se não estiver configurada. */
function obterUrl() {
  const url = process.env.DUTTYFY_PIX_URL_ENCRYPTED;
  if (!url) {
    throw new GatewayError('DUTTYFY_PIX_URL_ENCRYPTED não configurada no ambiente.');
  }
  return url;
}

/**
 * Identificador seguro da URL para log.
 * Nunca logue a URL completa — ela é a credencial.
 */
function urlParaLog(url) {
  return `...${url.slice(-8)}`;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch com timeout via AbortController. */
async function fetchComTimeout(url, opcoes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opcoes, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cria uma cobrança PIX.
 *
 * @param {object} params
 * @param {number} params.amountInCents  inteiro, >= 100
 * @param {string} params.titulo         item.title
 * @param {string} [params.descricao]
 * @param {object} params.cliente        { nome, documento, email, telefone } — só dígitos em documento/telefone
 * @param {string} [params.utm]          query string bruta da página de checkout
 * @returns {Promise<{pixCode:string, transactionId:string, status:string}>}
 */
async function criarCobranca({ amountInCents, titulo, descricao, cliente, utm }) {
  const url = obterUrl();

  const corpo = {
    amount: amountInCents,
    customer: {
      name: cliente.nome,
      document: cliente.documento,
      email: cliente.email,
      phone: cliente.telefone,
    },
    item: {
      title: titulo,
      price: amountInCents,
      quantity: 1,
    },
    paymentMethod: 'PIX',
  };
  if (descricao) corpo.description = descricao;
  if (utm) corpo.utm = utm;

  let ultimoErro;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    if (tentativa > 0) await dormir(BACKOFF_MS[tentativa - 1]);

    let resposta;
    try {
      resposta = await fetchComTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        },
        TIMEOUT_POST_MS
      );
    } catch (erro) {
      // Timeout ou falha de rede: elegível para retry.
      ultimoErro = new GatewayError(`Falha de rede ao criar cobrança (${erro.name}).`);
      console.error(`[duttyfy] POST ${urlParaLog(url)} tentativa ${tentativa + 1}: ${erro.name}`);
      continue;
    }

    // 4xx nunca é retentado — o pedido está malformado ou a credencial é inválida.
    if (resposta.status >= 400 && resposta.status < 500) {
      const detalhe = await resposta.text().catch(() => '');
      console.error(`[duttyfy] POST ${urlParaLog(url)} HTTP ${resposta.status}: ${detalhe.slice(0, 300)}`);
      if (resposta.status === 401) {
        throw new GatewayError('Credencial do gateway rejeitada. Gere uma nova Encrypted URL no painel.', 401);
      }
      throw new GatewayError('O gateway rejeitou os dados do pedido.', resposta.status);
    }

    if (!resposta.ok) {
      ultimoErro = new GatewayError(`Gateway indisponível (HTTP ${resposta.status}).`, resposta.status);
      console.error(`[duttyfy] POST ${urlParaLog(url)} HTTP ${resposta.status} tentativa ${tentativa + 1}`);
      continue;
    }

    const dados = await resposta.json().catch(() => null);
    if (!dados || !dados.pixCode || !dados.transactionId) {
      // Resposta 200 sem os campos essenciais: não retenta, para não
      // cobrar duas vezes caso a cobrança tenha sido criada.
      console.error(`[duttyfy] POST ${urlParaLog(url)} respondeu 200 sem pixCode/transactionId`);
      throw new GatewayError('Resposta inesperada do gateway.', 502);
    }

    return {
      pixCode: dados.pixCode,
      transactionId: dados.transactionId,
      status: dados.status || 'PENDING',
    };
  }

  throw ultimoErro || new GatewayError('Não foi possível criar a cobrança.');
}

/**
 * Consulta o status de uma transação.
 * Sem retry: o polling do frontend já repete a cada 5s.
 *
 * @param {string} transactionId
 * @returns {Promise<{status:string, paidAt?:string}>}
 */
async function consultarStatus(transactionId) {
  const url = obterUrl();
  const alvo = `${url}?transactionId=${encodeURIComponent(transactionId)}`;

  let resposta;
  try {
    resposta = await fetchComTimeout(alvo, { method: 'GET' }, TIMEOUT_GET_MS);
  } catch (erro) {
    throw new GatewayError(`Falha de rede ao consultar status (${erro.name}).`);
  }

  if (!resposta.ok) {
    console.error(`[duttyfy] GET ${urlParaLog(url)} HTTP ${resposta.status}`);
    throw new GatewayError(`Não foi possível consultar o status (HTTP ${resposta.status}).`, resposta.status);
  }

  const dados = await resposta.json().catch(() => null);
  if (!dados || !dados.status) {
    throw new GatewayError('Resposta inesperada do gateway.', 502);
  }

  // paidAt só existe quando status === 'COMPLETED'.
  const resultado = { status: dados.status };
  if (dados.paidAt) resultado.paidAt = dados.paidAt;
  return resultado;
}

module.exports = { GatewayError, criarCobranca, consultarStatus };
