import bcrypt from "bcryptjs";

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, stored) {
  // Support bcrypt hashes (start with $2)
  if (stored && stored.startsWith("$2")) {
    return bcrypt.compare(password, stored);
  }
  // Plaintext fallback (auto-migrate on login)
  return password === stored;
}
