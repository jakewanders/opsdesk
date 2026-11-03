import type { Metadata } from "next";
import { LegalPage, LegalSection, Notice } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Privacy | OpsDesk",
  description:
    "What OpsDesk stores, why, and for how long: demo sessions, real accounts, cookies, and logs.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro={
        <p>
          OpsDesk is a portfolio project. This page explains in plain language what the app stores
          and for how long. It is not legal advice.
        </p>
      }
    >
      <Notice>
        The live demo and real accounts are still being built. This notice describes how they are
        designed to work, and it will be checked against what actually ships before they open.
      </Notice>

      <LegalSection heading="The live demo">
        <p>
          The demo needs no email address. When you open it, the service creates an anonymous
          identity for your browser (a random user ID, with no name or email) and a private demo
          workspace filled with fictional records. A cookie keeps you signed in to that identity so
          your changes are still there if you come back.
        </p>
        <p>
          Please do not type real personal, customer, health, or payment information into the demo.
          Anything you enter is stored in the demo workspace like any other record.
        </p>
        <p>
          Each demo workspace is meant to expire after 24 hours. A scheduled cleanup is designed to
          delete expired demo workspaces and their anonymous identities. You can also reset your own
          workspace to the original sample data at any time.
        </p>
      </LegalSection>

      <LegalSection heading="Real accounts">
        <p>
          If you create an account, the authentication service stores your email address and a
          hashed password, and the app stores the workspace data you enter: customers,
          opportunities, tasks, quotes, and the activity history of changes.
        </p>
        <p>
          That data is kept until you archive or delete it. Nothing deletes real workspaces
          automatically. A way to contact the owner about access or deletion will be published on
          this page before real accounts open.
        </p>
      </LegalSection>

      <LegalSection heading="Technical identifiers and logs">
        <p>
          The authentication service creates technical identifiers for every session, such as user
          IDs, session tokens, and timestamps. The hosting and database providers also keep ordinary
          request logs, which can include IP addresses and browser details. OpsDesk does not claim
          that no data is collected.
        </p>
        <p>
          The app&apos;s own server logs are designed to carry a request ID and the kind of error,
          and never passwords, tokens, or the text of your notes.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies and local storage">
        <ul className="list-disc pl-5">
          <li>
            <strong>Sign-in session cookies</strong> keep you signed in. They are set for this site
            only and are required for the demo and for accounts.
          </li>
          <li>
            <strong>Theme preference</strong> (light, dark, or system) is saved in your
            browser&apos;s local storage so the page does not flash the wrong theme. It never leaves
            your browser.
          </li>
        </ul>
        <p>There are no advertising cookies.</p>
      </LegalSection>

      <LegalSection heading="Services that process data">
        <p>
          OpsDesk is designed to use a hosting provider (Netlify), a database and authentication
          provider (Supabase), and a bot check on the demo entry (Cloudflare Turnstile), which looks
          at browser signals to tell people from scripts. Each processes data as needed to provide
          its service.
        </p>
      </LegalSection>

      <LegalSection heading="Analytics">
        <p>
          This site does not use cookies for analytics and does not use any third-party analytics
          service. It does keep daily aggregate counts of how many demo workspaces were started and
          which features they used, for example whether a visitor created a customer or completed a
          task. The counts are worked out on the server from the demo workspace before it is
          deleted, and they contain no personal data, identifiers, or IP addresses. They exist only
          to understand whether the demo works.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          When the product changes in a way that affects this notice, this page is updated and the
          date at the top changes.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
