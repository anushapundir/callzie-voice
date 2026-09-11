import Image from "next/image";
import { Wordmark } from "@/components/brand/wordmark";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="auth-shell">
      <section className="auth-story" aria-label="Welcome to Callzie">
        <Wordmark size="lg" href="/landing" />
        <div className="auth-story-copy">
          <p className="workspace-eyebrow">A LITTLE MORE HUMAN TIME</p>
          <h2>A full calendar.<br /><em>A lighter day.</em></h2>
          <p>Maya takes care of the calls and the back-and-forth. You get back to the work you love.</p>
          <div className="auth-maya-note">
            <Image src="/maya-avatar.png" alt="Maya, your AI calling assistant" width={48} height={48} />
            <div><strong>Meet your extra pair of hands.</strong><p>Calls, confirmations, and one less thing.</p></div>
          </div>
        </div>
        <p className="auth-story-foot">Your business. Your rhythm. A little help from Maya.</p>
      </section>
      <main className="auth-form">{children}</main>
    </div>
  );
}
