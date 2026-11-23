// Paiement des cours via FlexPay (RDC). Le prix vient toujours du serveur, jamais du navigateur.
// Vérifiez les URL et champs dans la documentation FlexPay de votre compte marchand avant la mise en ligne.
import { HttpError } from "./grade.js";
import { isPaid } from "./access.js";

const MOBILE_URL = "https://backend.flexpay.cd/api/rest/v1/paymentService";
const CARD_URL = "https://cardpayment.flexpay.cd/v1.1/pay";
const CHECK_URL = "https://backend.flexpay.cd/api/rest/v1/check/";
const DAY = 24 * 3600 * 1000;
const call = async (fetchFn, url, token, body) => {
  const r = await fetchFn(url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
// FlexPay veut le numéro au format 243XXXXXXXXX
const phone243 = p => { const d = String(p || "").replace(/\D/g, ""); if (d.startsWith("243")) return d; if (d.startsWith("0")) return "243" + d.slice(1); return "243" + d; };

export async function startPayment({ db, uid, courseId, plan, method, phone, env, fetchFn = fetch, now = Date.now() }) {
  if (!env.FLEXPAY_TOKEN || !env.FLEXPAY_MERCHANT) throw new HttpError(503, "payment-not-configured");
  if (typeof courseId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(courseId)) throw new HttpError(400, "course");
  if (plan !== "once" && plan !== "month") throw new HttpError(400, "plan");
  const cs = await db.collection("courses").doc(courseId).get();
  if (!cs.exists || cs.data().published !== true) throw new HttpError(404, "course");
  const c = cs.data(), allowed = c.pay || "both";
  if (method !== "mobile" && method !== "card") throw new HttpError(400, "method");
  if (allowed !== "both" && allowed !== method) throw new HttpError(400, "method");
  const amount = Math.round(Number(plan === "month" ? c.monthly : c.price));
  if (!isPaid(c) || !(amount > 0)) throw new HttpError(400, "no-price");
  const currency = env.PAY_CURRENCY || "USD";
  const site = (env.PUBLIC_SITE_URL || "").replace(/\/$/, ""), me = (env.SERVER_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (!site || !me) throw new HttpError(503, "payment-not-configured");
  if (method === "mobile" && !/^\d{9,12}$/.test(String(phone || "").replace(/\D/g, ""))) throw new HttpError(400, "phone");
  const txId = "KDA" + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
  await db.collection("orders").doc(txId).set({ uid, courseId, plan, amount, currency, method, status: "pending", createdAt: new Date(now) });
  const back = site + "/cours-detail.html?id=" + courseId + "&paid=" + txId;
  let out;
  if (method === "mobile") {
    out = await call(fetchFn, MOBILE_URL, env.FLEXPAY_TOKEN, { merchant: env.FLEXPAY_MERCHANT, type: "1", phone: phone243(phone), reference: txId, amount: String(amount), currency, callbackUrl: me + "/pay/notify" });
    if (!(out.status === 200 && String(out.j.code) === "0")) return fail(db, txId, out, "MOBILE");
    return { paymentUrl: null, txId };
  }
  out = await call(fetchFn, CARD_URL, env.FLEXPAY_TOKEN, { authorization: "Bearer " + env.FLEXPAY_TOKEN, merchant: env.FLEXPAY_MERCHANT, reference: txId, amount: String(amount), currency,
    description: ("Cours " + (c.title || "")).slice(0, 80), callback_url: me + "/pay/notify", approve_url: back, cancel_url: back, decline_url: back, home_url: site });
  const url = out.j && out.j.url;
  if (!(String(out.j.code) === "0" && url)) return fail(db, txId, out, "CARTE");
  return { paymentUrl: url, txId };
}
async function fail(db, txId, out, tag) {
  console.error("FLEXPAY INIT " + tag + " :", out.status, out.j && out.j.code, out.j && out.j.message);
  await db.collection("orders").doc(txId).update({ status: "failed" });
  throw new HttpError(502, "gateway");
}

// Vérifie auprès de FlexPay (jamais sur la foi du navigateur) puis donne l'accès. Appel répétable sans risque.
export async function settleOrder({ db, txId, env, fetchFn = fetch, now = Date.now() }) {
  const ref = db.collection("orders").doc(txId), o = await ref.get();
  if (!o.exists) throw new HttpError(404, "order");
  if (o.data().status === "paid") return { status: "paid", courseId: o.data().courseId };
  if (o.data().status === "mismatch") return { status: "mismatch" };
  if (["refused", "failed"].includes(o.data().status)) return { status: "refused" };
  const { j } = await call(fetchFn, CHECK_URL + encodeURIComponent(txId), env.FLEXPAY_TOKEN);
  const t = j && j.transaction, st = t && String(t.status);
  if (String(j.code) !== "0" || !t) return { status: "pending" };
  if (st === "1") { await ref.update({ status: "refused" }); return { status: "refused" }; } // 0 = payé, 1 = échec, 2 = en attente
  if (st !== "0") return { status: "pending" };
  const ord = o.data();
  if (Math.round(Number(t.amount)) !== ord.amount || String(t.currency) !== ord.currency) {
    console.error("FLEXPAY MONTANT DIFFÉRENT :", txId, t.amount, t.currency, "attendu", ord.amount, ord.currency);
    await ref.update({ status: "mismatch" }); return { status: "mismatch" };
  }
  await db.runTransaction(async tx => {
    const cur = await tx.get(ref); if (cur.data().status === "paid") return;
    const eRef = db.collection("entitlements").doc(ord.uid + "_" + ord.courseId), e = await tx.get(eRef);
    let until = null;
    if (ord.plan === "month") {
      const old = e.exists ? e.data().until : undefined;
      if (e.exists && old == null) until = null;
      else { const base = Math.max(now, old && old.toMillis ? old.toMillis() : 0); until = new Date(base + 30 * DAY); }
    }
    tx.set(eRef, { uid: ord.uid, courseId: ord.courseId, plan: ord.plan, until, txId, updatedAt: new Date(now) });
    tx.update(ref, { status: "paid", paidAt: new Date(now) });
  });
  return { status: "paid", courseId: ord.courseId };
}
