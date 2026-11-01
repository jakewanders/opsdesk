import { z } from "zod";
import { email as emailSchema } from "@/lib/validation";

/** Supabase hashes passwords with bcrypt, which ignores everything past 72 bytes. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

/** Passwords are never trimmed or normalized: the user's exact characters are the secret. */
const newPassword = z
  .string({ error: "Enter a password." })
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .refine((v) => new TextEncoder().encode(v).length <= PASSWORD_MAX, {
    error: `Use ${PASSWORD_MAX} bytes or fewer (about ${PASSWORD_MAX} letters).`,
  });

/** An empty email reads "Enter your email address.", anything else follows the shared email rules. */
const email = () =>
  z
    .string({ error: "Enter your email address." })
    .trim()
    .min(1, "Enter your email address.")
    .pipe(emailSchema());

const captchaToken = z
  .string({ error: "Complete the check below." })
  .min(1, "Complete the check below.");

export const loginSchema = z.object({
  email: email(),
  // A login only needs "something typed": the length rules apply when a password is chosen.
  password: z.string({ error: "Enter your password." }).min(1, "Enter your password."),
  captchaToken,
});

export const signupSchema = z.object({
  email: email(),
  password: newPassword,
  captchaToken,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;

export const forgotPasswordSchema = z.object({ email: email(), captchaToken });

export const resetPasswordSchema = z
  .object({
    password: newPassword,
    confirm: z.string({ error: "Repeat the new password." }).min(1, "Repeat the new password."),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    error: "The passwords do not match.",
  });

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
