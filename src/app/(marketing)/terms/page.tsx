import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, Notice } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Terms | OpsDesk",
  description:
    "OpsDesk is a portfolio demonstration: fictional data only, no uptime guarantee, no compliance certifications.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      intro={
        <p>
          By using OpsDesk you agree to these plain-language terms. They are not legal advice. If
          you do not agree, please do not use the site.
        </p>
      }
    >
      <Notice>
        The live demo and real accounts are still being built. These terms describe how they are
        intended to work and will be checked against what ships before they open.
      </Notice>

      <LegalSection heading="What OpsDesk is">
        <p>
          OpsDesk is a portfolio demonstration of software engineering work. It is not an operating
          business, and it is not a product you can rely on to run yours.
        </p>
      </LegalSection>

      <LegalSection heading="Fictional data only">
        <p>
          Use the demo with fictional information. Do not enter real customer records, health
          information, payment card details, government identifiers, or any other sensitive or
          regulated data. The sample records the demo starts with are fictional.
        </p>
      </LegalSection>

      <LegalSection heading="No uptime guarantee">
        <p>
          OpsDesk runs on free-tier hosting and database plans that can be paused, limited, or
          changed by their providers. It may be slow, unavailable, changed, or removed at any time
          without notice. Demo workspaces expire after about 24 hours and their data is deleted.
          There is no backup or recovery promise for demo data.
        </p>
      </LegalSection>

      <LegalSection heading="No compliance certifications">
        <p>
          OpsDesk is not certified or audited for HIPAA, SOC 2, PCI DSS, or any other compliance
          framework, and it must not be used for data that those frameworks cover.
        </p>
      </LegalSection>

      <LegalSection heading="Fair use">
        <ul className="list-disc pl-5">
          <li>Do not try to read, change, or delete anyone else&apos;s workspace or data.</li>
          <li>
            Do not probe the service for weaknesses, overload it, or script bulk sign-ups. Limits on
            demo size and creation rate are there on purpose.
          </li>
          <li>Do not store unlawful, harmful, or infringing content.</li>
        </ul>
        <p>Access that breaks these rules can be blocked.</p>
      </LegalSection>

      <LegalSection heading="Real accounts">
        <p>
          If real accounts are offered, they are provided for evaluation. Your data is kept until
          you archive or delete it, and the service can still change or end, so keep your own copy
          of anything that matters. How your data is handled is described on the{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy
          </Link>{" "}
          page.
        </p>
      </LegalSection>

      <LegalSection heading="No warranty">
        <p>
          OpsDesk is provided as is, without warranties of any kind, to the extent the law allows.
          Use it at your own risk.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          These terms may change as the product does. The date at the top shows the latest update.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
