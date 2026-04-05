import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { User } from "../types.js";

export function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function createToken(user: User) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwtSecret as jwt.Secret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string) {
  return jwt.verify(token, config.jwtSecret) as { sub: string; email: string; role: User["role"] };
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
