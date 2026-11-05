(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMPurchaseModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
  function monthDistance(from, to) {
    if (!monthValid(from) || !monthValid(to)) return 0;
    const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
    return (ty - fy) * 12 + tm - fm;
  }
  function list(state) { return Object.values(state.plannedPurchases || {}).filter(item => item && !item.deletedAt && monthValid(item.month)); }
  function linkedTransaction(state, item) {
    return state.transactions.find(tx => tx.id === item.transactionId || tx.id === `planned_${item.id}`) || null;
  }
  function summary(state, month, currentMonth) {
    const items = list(state).filter(item => item.month === month);
    const outstanding = items.filter(item => item.status !== "cancelled" && (!linkedTransaction(state, item) || linkedTransaction(state, item)?.deletedAt));
    const total = outstanding.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const saved = outstanding.reduce((sum, item) => sum + Math.min(Number(item.savedAmount || 0), Number(item.amount || 0)), 0);
    return { items, total, saved, remaining: total - saved, monthlySaving: Math.ceil((total - saved) / Math.max(1, monthDistance(currentMonth, month) + 1)) };
  }
  function withPurchase(state, values, id) {
    const amount = Number(values.amount), savedAmount = Number(values.savedAmount || 0), title = String(values.title || "").trim();
    if (!title || title.length > 180) throw new Error("أدخل اسم المشتريات بما لا يزيد على 180 حرفاً");
    if (!monthValid(values.month)) throw new Error("اختر شهراً صحيحاً للشراء");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("أدخل تكلفة تقديرية صحيحة");
    if (!Number.isFinite(savedAmount) || savedAmount < 0 || savedAmount > amount) throw new Error("المبلغ المخصص يجب أن يكون بين صفر وتكلفة المشتريات");
    const old = state.plannedPurchases?.[id];
    if (old && linkedTransaction(state, old) && !linkedTransaction(state, old).deletedAt) throw new Error("تم تسجيل الشراء؛ عدّل العملية الفعلية من قسم العمليات");
    const item = { ...old, id, title, month:values.month, amount, savedAmount, categoryId:values.categoryId || "", priority:["high","normal","low"].includes(values.priority) ? values.priority : "normal", note:String(values.note || "").trim(), status:"planned" };
    return { ...state, plannedPurchases:{ ...state.plannedPurchases, [id]:item } };
  }
  return { list, linkedTransaction, summary, withPurchase, monthDistance };
});
