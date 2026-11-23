// Payant = prix d'achat > 0, ou inclus dans le Pass 30 jours (passOk). Pass = accès « ALL » à tous les cours passOk.
export const isPaid = c => Number(c && c.price) > 0 || (c && c.passOk) === true;

// Droit d'accès : cours gratuit, ou accès acheté et encore valide.
export async function hasAccess(db, uid, courseId, course, now = Date.now()) {
  if (!isPaid(course)) return true;
  const ok = s => { if (!s.exists) return false; const u = s.data().until; return u == null || (u.toMillis ? u.toMillis() : Number(u)) > now; };
  if (ok(await db.collection("entitlements").doc(uid + "_" + courseId).get())) return true;
  return course.passOk === true && ok(await db.collection("entitlements").doc(uid + "_ALL").get());
}
