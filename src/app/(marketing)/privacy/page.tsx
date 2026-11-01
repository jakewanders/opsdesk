import type { Metadata } from "next";
import { StatePanel } from "@/components/shared/state-panel";

export const metadata: Metadata = { title: "Privacy | OpsDesk" };

export default function Page() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center p-6"
    >
      <StatePanel
        title="Privacy"
        description="The full privacy notice for the live demo is still being written and will be published before the demo opens."
      />
    </main>
  );
}
