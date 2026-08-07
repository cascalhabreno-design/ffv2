/**
 * Catálogo e cálculo de preço — FONTE DA VERDADE.
 *
 * O preço NUNCA vem do navegador. O frontend envia apenas SKUs;
 * o valor em centavos é resolvido aqui, no servidor.
 *
 * Todos os valores estão em CENTAVOS (contrato da DuttyFy: inteiro, >= 100).
 */

// Denominações de diamantes — o cliente escolhe exatamente uma.
const DENOMINACOES = {
  'dia-1060':  { diamantes: 1060,  bonus: 106,  precoEmCentavos: 1290 },
  'dia-2180':  { diamantes: 2180,  bonus: 218,  precoEmCentavos: 1790 },
  'dia-5600':  { diamantes: 5600,  bonus: 560,  precoEmCentavos: 1990 },
  'dia-22400': { diamantes: 22400, bonus: 2240, precoEmCentavos: 4990 },
};

// Ofertas especiais — opcional, no máximo uma.
const OFERTAS = {
  'ofr-semanal': { nome: 'Assinatura Semanal',            precoEmCentavos: 890 },
  'ofr-mensal':  { nome: 'Assinatura Mensal',             precoEmCentavos: 1990 },
  'ofr-booyah':  { nome: 'Passe Booyah Premium Plus',     precoEmCentavos: 1290 },
};

// Order bumps — opcional, quantos o cliente quiser.
const ORDER_BUMPS = {
  'bmp-calca-angelical':   { nome: 'Calça Angelical Azul',              precoEmCentavos: 1799 },
  'bmp-2180-diamantes':    { nome: '2180 Diamantes Desconto',           precoEmCentavos: 1584 },
  'bmp-conjunto-coelhao':  { nome: 'Conjunto Coelhão',                  precoEmCentavos: 1439 },
  'bmp-guardiao-lendario': { nome: 'Conjunto Guardião Lendário',        precoEmCentavos: 1399 },
  'bmp-barba-velho':       { nome: 'Máscara Antiga Barba do Velho',     precoEmCentavos: 1782 },
};

/** Erro de pedido inválido — vira HTTP 400, com mensagem exibível ao cliente. */
class PedidoInvalidoError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'PedidoInvalidoError';
  }
}

/**
 * Resolve um pedido em valor total e descrição.
 *
 * @param {object} pedido
 * @param {string} pedido.denomSku   SKU da denominação (obrigatório)
 * @param {string} [pedido.ofertaSku] SKU da oferta especial
 * @param {string[]} [pedido.bumpSkus] SKUs dos order bumps
 * @param {string} [pedido.uid]      ID do jogador, para a entrega manual
 * @returns {{amountInCents:number, titulo:string, descricao:string, itens:string[]}}
 */
function calcularPedido({ denomSku, ofertaSku, bumpSkus = [], uid = '' } = {}) {
  const denom = DENOMINACOES[denomSku];
  if (!denom) {
    throw new PedidoInvalidoError('Pacote de diamantes inválido.');
  }

  let total = denom.precoEmCentavos;
  const itens = [`${denom.diamantes + denom.bonus} Diamantes Free Fire`];

  if (ofertaSku) {
    const oferta = OFERTAS[ofertaSku];
    if (!oferta) {
      throw new PedidoInvalidoError('Oferta especial inválida.');
    }
    total += oferta.precoEmCentavos;
    itens.push(oferta.nome);
  }

  if (!Array.isArray(bumpSkus)) {
    throw new PedidoInvalidoError('Lista de itens adicionais inválida.');
  }
  // Set: ignora SKU repetido, evitando cobrar o mesmo bump duas vezes.
  for (const sku of new Set(bumpSkus)) {
    const bump = ORDER_BUMPS[sku];
    if (!bump) {
      throw new PedidoInvalidoError('Item adicional inválido.');
    }
    total += bump.precoEmCentavos;
    itens.push(bump.nome);
  }

  // Piso do gateway. Impossível de atingir com o catálogo atual, mas
  // protege caso algum preço seja reduzido no futuro.
  if (total < 100) {
    throw new PedidoInvalidoError('Valor mínimo de R$ 1,00 não atingido.');
  }

  // O UID entra no título porque a entrega é manual: assim o painel da
  // DuttyFy mostra para qual conta creditar, sem depender de banco de dados.
  const sufixoUid = uid ? ` — UID ${uid}` : '';
  const titulo = `${itens[0]}${sufixoUid}`.slice(0, 120);

  return {
    amountInCents: total,
    titulo,
    descricao: `${itens.join(' + ')}${sufixoUid}`.slice(0, 255),
    itens,
  };
}

module.exports = {
  DENOMINACOES,
  OFERTAS,
  ORDER_BUMPS,
  PedidoInvalidoError,
  calcularPedido,
};
