"use client";

import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

/**
 * Mount once, near the root. sonner renders a polite live region (`aria-live="polite"`), so
 * messages are announced without stealing focus. Motion is removed by the global
 * `prefers-reduced-motion` rule in globals.css.
 */
export function ToastProvider() {
  return <Toaster position="bottom-right" closeButton />;
}

/**
 * Contextual result messages. Name the action in past tense, matching the button that was
 * pressed: a "Save changes" button produces "Changes saved".
 */
export const notify = {
  /** `action` adds one button to the toast, for example Undo. */
  success: (
    message: string,
    description?: string,
    action?: { label: string; onClick: () => void },
  ) => toast.success(message, { description, action }),
  info: (message: string, description?: string) => toast.info(message, { description }),
  /** For recoverable problems that do not block the page. Blocking errors use ErrorAlert. */
  error: (message: string, description?: string) => toast.error(message, { description }),
};
