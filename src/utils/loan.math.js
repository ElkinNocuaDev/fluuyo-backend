function eaToEm(ea) {
  // ea en decimal: 0.22 = 22%
  return Math.pow(1 + ea, 1 / 12) - 1;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Cuota fija (francés): A = P * [ i(1+i)^n ] / [ (1+i)^n - 1 ]
 */
function fixedInstallment(principal, monthlyRate, nMonths) {
  const P = Number(principal);
  const i = Number(monthlyRate);
  const n = Number(nMonths);

  if (n <= 0) throw new Error('nMonths inválido');
  if (i === 0) return round2(P / n);

  const pow = Math.pow(1 + i, n);
  const A = P * (i * pow) / (pow - 1);
  return round2(A);
}

function totalPayable(installment, nMonths) {
  return round2(Number(installment) * Number(nMonths));
}

module.exports = { eaToEm, fixedInstallment, totalPayable, round2 };
