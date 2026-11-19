// Correction du test final côté serveur : les bonnes réponses ne quittent jamais ce serveur.
// Fonctions pures + un gestionnaire qui reçoit la base de données (Admin SDK) en paramètre, donc testable sans Firebase.

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode(rand = Math.random) {
  let s = ""; for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return "KDA-" + s;
}

// Réponses attendues : document secret en priorité, sinon anciennes questions qui contenaient encore « answer ».
export function answerKey(quiz, secret) {
  const items = secret && Array.isArray(secret.items) ? secret.items : null;
  if (items && items.length !== quiz.length) return { error: "key-mismatch" };
  const key = quiz.map((q, i) => items ? items[i] : { a: q.answer, e: q.explain });
  if (key.some(k => !k || k.a === undefined || k.a === null || (Array.isArray(k.a) && !k.a.length))) return { error: "key-missing" };
  return { key };
}

// Vérifie la forme des réponses envoyées : une par question, indices valides.
export function cleanAnswers(quiz, answers) {
  if (!Array.isArray(answers) || answers.length !== quiz.length) return null;
  const out = [];
  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i], a = answers[i], n = (q.options || []).length;
    if (q.type === "multi") {
      if (!Array.isArray(a) || a.length > n || a.some(x => !Number.isInteger(x) || x < 0 || x >= n) || new Set(a).size !== a.length) return null;
      out.push([...a].sort((x, y) => x - y));
    } else {
      if (a === null) { out.push(null); continue; }
      if (!Number.isInteger(a) || a < 0 || a >= n) return null;
      out.push(a);
    }
  }
  return out;
}

export function grade(quiz, key, answers) {
  let ok = 0;
  const results = quiz.map((q, i) => {
    const a = answers[i], k = key[i].a; let good;
    if (q.type === "multi") { const A = [...(a || [])].sort((x, y) => x - y).join(), B = [...k].sort((x, y) => x - y).join(); good = A === B && A !== ""; }
    else good = a === k;
    if (good) ok++; return good;
  });
  return { pct: quiz.length ? Math.round(ok / quiz.length * 100) : 0, results };
}

export class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

// db : instance Firestore (Admin SDK) ; FieldValue : firebase-admin/firestore
export const MAX_PER_DAY = 6, DAY = 24 * 3600 * 1000;
export async function gradeCourse({ db, FieldValue, uid, token = {}, courseId, answers, rand, now = Date.now() }) {
  if (typeof courseId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(courseId)) throw new HttpError(400, "course");
  const cs = await db.collection("courses").doc(courseId).get();
  if (!cs.exists) throw new HttpError(404, "course");
  const course = cs.data();
  if (course.published !== true && course.authorId !== uid) throw new HttpError(404, "course");
  const quiz = Array.isArray(course.quiz) ? course.quiz : [];
  if (!quiz.length) throw new HttpError(400, "no-quiz");

  const secret = await db.collection("courses").doc(courseId).collection("secret").doc("key").get();
  const k = answerKey(quiz, secret.exists ? secret.data() : null);
  if (k.error) throw new HttpError(409, k.error);
  const clean = cleanAnswers(quiz, answers);
  if (!clean) throw new HttpError(400, "answers");

  const pref = db.collection("progress").doc(uid + "_" + courseId);
  const ps = await pref.get(), prev = ps.exists ? ps.data() : null;
  const nLessons = Array.isArray(course.lessons) ? course.lessons.length : 0;
  const done = new Set(prev && Array.isArray(prev.done) ? prev.done : []);
  if (!prev || [...Array(nLessons).keys()].some(i => !done.has(i))) throw new HttpError(403, "lessons-incomplete");

  // 6 essais par période de 24 heures et par cours
  const tries = (prev && Array.isArray(prev.tries) ? prev.tries : []).filter(x => Number.isFinite(x) && now - x < DAY);
  if (tries.length >= MAX_PER_DAY) throw new HttpError(429, "daily-limit");

  const { pct, results } = grade(quiz, k.key, clean);
  const passMark = Math.min(100, Math.max(1, Number(course.passMark) || 70));
  const pass = pct >= passMark;
  const patch = { score: Math.max(prev.score || 0, pct), attempts: (prev.attempts || 0) + 1, tries: [...tries, now], updatedAt: FieldValue.serverTimestamp() };
  let certCode = prev.certCode || null;
  if (pass) {
    patch.passed = true;
    if (!certCode) {
      const us = await db.collection("users").doc(uid).get();
      const name = (us.exists && us.data().name) || token.name || token.email || "";
      for (let t = 0; t < 6 && !certCode; t++) {
        const code = newCode(rand);
        try {
          await db.collection("certificates").doc(code).create({ code, uid, name, courseId, courseTitle: course.title || "", trainer: course.authorName || "", category: course.category || "", level: course.level || "", hours: Math.round((Number(course.duration) || 0) / 6) / 10 || null, skills: (Array.isArray(course.objectives) ? course.objectives : []).filter(x => typeof x === "string").slice(0, 4).map(x => x.slice(0, 120)), score: pct, date: FieldValue.serverTimestamp() });
          certCode = code;
        } catch (e) { if (t === 5) throw e; }
      }
      patch.certCode = certCode;
    }
  }
  await pref.set(patch, { merge: true });
  return { ok: true, pct, pass, passMark, best: patch.score, attempts: patch.attempts, triesLeft: MAX_PER_DAY - patch.tries.length, passed: !!(prev.passed || pass), certCode, results,
    explains: pass ? k.key.map(x => x.e || "") : null };
}
