import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Check } from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";
import { MarketingNavbar, PillButton } from "@/components/marketing/navbar";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes";
import { CallStory } from "./call-story";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Callzie — Your hands are full. Let Maya make the call.",
  description: "Keep doing what you love. Maya, your AI calling assistant, calls your customers, finds a time that works, and books it into your calendar.",
};

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <MarketingNavbar />
      <main id="main" className={styles.container}>
        <CallStory />
        <section id="how-it-works" className={styles.setup}>
          <div>
            <p className={styles.eyebrow}>A SMALL HANDOFF. A BIG EXHALE.</p>
            <h2>Your business.<br /><em>Her next call.</em></h2>
          </div>
          <ol className={styles.steps}>
            <li><span>01</span><div><h3>A little introduction.</h3><p>Tell Maya about your business, connect Google Calendar, and choose your working hours.</p></div></li>
            <li><span>02</span><div><h3>A name. A number. Leave it with her.</h3><p>Add an appointment or bring a whole list. Maya calls to confirm or find a better time.</p></div></li>
            <li><span>03</span><div><h3>Get on with your day.</h3><p>The booking, recording, and transcript are ready when you are. Anything that needs you gets flagged.</p></div></li>
          </ol>
        </section>
        <section className={styles.closing}>
          <span className={styles.closingMark} aria-hidden>c.</span>
          <p className={styles.eyebrow}>LESS CHASING. MORE LIVING.</p>
          <h2>Good things happen<br />when you <em>get your time back.</em></h2>
          <PillButton href={SIGN_UP_URL} size="lg">Let Maya take it from here <ArrowUpRight size={18} aria-hidden /></PillButton>
          <p className={styles.finePrint}><Check size={13} aria-hidden /> Free to try. No card needed.</p>
        </section>
      </main>
      <footer className={styles.footer}>
        <Wordmark size="lg" />
        <p>A little more human time.</p>
        <Link href={SIGN_IN_URL}>Sign in <ArrowUpRight size={14} aria-hidden /></Link>
        <span>© {new Date().getFullYear()} Callzie</span>
      </footer>
    </div>
  );
}
