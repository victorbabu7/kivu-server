// Lancer : npm test  (ne demande ni Firebase ni internet)
import test from "node:test";
import assert from "node:assert/strict";
import { grade, cleanAnswers, answerKey, gradeCourse, newCode, HttpError, MAX_PER_DAY, DAY } from "./grade.js";

const quiz = [
  { q: "A", type: "single", options: ["a", "b", "c"] },
  { q: "B", type: "multi", options: ["a", "b", "c", "d"] },
  { q: "C", type: "tf", options: ["Vrai", "Faux"] },
];
const secret = { items: [{ a: 1, e: "e1" }, { a: [0, 2], e: "e2" }, { a: 0, e: "e3" }] };

// Base de données factice (mêmes appels que l'Admin SDK)
function fakeDb(docs) {
  const store = new Map(Object.entries(docs));
  const ref = path => ({
    path,
    async get() { return { exists: store.has(path), data: () => store.get(path) }; },
    async set(d, o) { store.set(path, o && o.merge ? { ...(store.get(path) || {}), ...d } : d); },
    async create(d) { if (store.has(path)) throw new Error("exists"); store.set(path, d); },
    collection(n) { return { doc: id => ref(`${path}/${n}/${id}`) }; },
  });
  return { store, collection: n => ({ doc: id => ref(`${n}/${id}`) }) };
}
const FV = { serverTimestamp: () => "TS" };
const base = () => ({
  "courses/c1": { published: true, title: "Data", authorName: "Formateur", passMark: 70, lessons: [{}, {}], quiz },
  "courses/c1/secret/key": secret,
  "progress/u1_c1": { uid: "u1", courseId: "c1", done: [0, 1] },
  "users/u1": { name: "Amani Mukendi" },
});
const run = (db, answers, extra = {}) => gradeCourse({ db, FieldValue: FV, uid: "u1", courseId: "c1", answers, ...extra });

test("correction : tout juste = 100 %", () => {
  const r = grade(quiz, secret.items, [1, [2, 0], 0]);
  assert.equal(r.pct, 100); assert.deepEqual(r.results, [true, true, true]);
});
test("correction : choix multiple incomplet ou excessif = faux", () => {
  assert.equal(grade(quiz, secret.items, [1, [0], 0]).results[1], false);
  assert.equal(grade(quiz, secret.items, [1, [0, 1, 2], 0]).results[1], false);
  assert.equal(grade(quiz, secret.items, [null, [], null]).pct, 0);
});
test("réponses mal formées refusées", () => {
  assert.equal(cleanAnswers(quiz, [1, [0], 0]) !== null, true);
  assert.equal(cleanAnswers(quiz, [1, [0]]), null);            // trop courtes
  assert.equal(cleanAnswers(quiz, [9, [0], 0]), null);         // indice hors limites
  assert.equal(cleanAnswers(quiz, [1, 0, 0]), null);           // multi sans liste
  assert.equal(cleanAnswers(quiz, [1, [0, 0], 0]), null);      // doublons
  assert.equal(cleanAnswers(quiz, "x"), null);
});
test("clé : anciennes questions avec « answer » encore acceptées", () => {
  const legacy = [{ q: "A", type: "single", options: ["a", "b"], answer: 1 }];
  assert.deepEqual(answerKey(legacy, null).key, [{ a: 1, e: undefined }]);
  assert.equal(answerKey(quiz, null).error, "key-missing");
  assert.equal(answerKey(quiz, { items: [{ a: 0 }] }).error, "key-mismatch");
});
test("réussite : certificat créé, progression écrite par le serveur", async () => {
  const db = fakeDb(base());
  const r = await run(db, [1, [0, 2], 0]);
  assert.equal(r.pass, true); assert.equal(r.pct, 100); assert.match(r.certCode, /^KDA-[A-Z2-9]{8}$/);
  assert.deepEqual(r.explains, ["e1", "e2", "e3"]);
  const p = db.store.get("progress/u1_c1"); assert.equal(p.passed, true); assert.equal(p.score, 100); assert.equal(p.attempts, 1); assert.equal(p.certCode, r.certCode);
  const c = db.store.get("certificates/" + r.certCode); assert.equal(c.name, "Amani Mukendi"); assert.equal(c.uid, "u1"); assert.equal(c.courseTitle, "Data");
});
test("échec : pas de certificat, réponses non révélées", async () => {
  const db = fakeDb(base());
  const r = await run(db, [0, [0], 1]);
  assert.equal(r.pass, false); assert.equal(r.certCode, null); assert.equal(r.explains, null);
  assert.equal(JSON.stringify(r).includes('"a"'), false);
  const p = db.store.get("progress/u1_c1"); assert.equal(p.passed, undefined); assert.equal(p.attempts, 1);
  assert.equal([...db.store.keys()].some(k => k.startsWith("certificates/")), false);
});
test("repasser : meilleur score gardé, un seul certificat", async () => {
  const db = fakeDb(base());
  const a = await run(db, [1, [0, 2], 0]);
  const b = await run(db, [0, [0], 1]);
  assert.equal(b.best, 100); assert.equal(b.certCode, a.certCode); assert.equal(b.attempts, 2); assert.equal(b.passed, true);
  assert.equal([...db.store.keys()].filter(k => k.startsWith("certificates/")).length, 1);
});
test("leçons non terminées : refusé", async () => {
  const d = base(); d["progress/u1_c1"].done = [0];
  await assert.rejects(run(fakeDb(d), [1, [0, 2], 0]), e => e instanceof HttpError && e.code === "lessons-incomplete" && e.status === 403);
  const d2 = base(); delete d2["progress/u1_c1"];
  await assert.rejects(run(fakeDb(d2), [1, [0, 2], 0]), e => e.code === "lessons-incomplete");
});
test("cours inconnu, non publié, sans test ou mal formé : refusé", async () => {
  await assert.rejects(gradeCourse({ db: fakeDb(base()), FieldValue: FV, uid: "u1", courseId: "zz", answers: [] }), e => e.code === "course");
  await assert.rejects(gradeCourse({ db: fakeDb(base()), FieldValue: FV, uid: "u1", courseId: "../x", answers: [] }), e => e.code === "course");
  const d = base(); d["courses/c1"].published = false;
  await assert.rejects(run(fakeDb(d), [1, [0, 2], 0]), e => e.code === "course");
  const d2 = base(); d2["courses/c1"].quiz = [];
  await assert.rejects(run(fakeDb(d2), []), e => e.code === "no-quiz");
  await assert.rejects(run(fakeDb(base()), [1, [0, 2]]), e => e.code === "answers");
});
test("seuil de réussite du cours respecté", async () => {
  const d = base(); d["courses/c1"].passMark = 90;
  const r = await run(fakeDb(d), [1, [0], 0]);   // 2 sur 3 = 67 %
  assert.equal(r.pct, 67); assert.equal(r.pass, false);
});
test("codes de certificat : format valide", () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^KDA-[A-Z0-9]{8}$/);
});

test("limite : 6 essais par 24 h, puis refus ; l'essai se libère après 24 h", async () => {
  const db = fakeDb(base()), t0 = 1_700_000_000_000;
  for (let i = 0; i < MAX_PER_DAY; i++) { const r = await run(db, [0, [0], 1], { now: t0 + i * 1000 }); assert.equal(r.triesLeft, MAX_PER_DAY - 1 - i); }
  await assert.rejects(run(db, [1, [0, 2], 0], { now: t0 + 10_000 }), e => e instanceof HttpError && e.status === 429 && e.code === "daily-limit");
  assert.equal(db.store.get("progress/u1_c1").passed, undefined);
  const r = await run(db, [1, [0, 2], 0], { now: t0 + DAY + 6000 });
  assert.equal(r.pass, true); assert.equal(r.triesLeft, MAX_PER_DAY - 1);
});
