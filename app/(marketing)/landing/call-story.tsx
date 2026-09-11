"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ArrowDown, ArrowUpRight, Bell, CalendarDays, Check, CheckCheck, ChevronRight, MessageCircle, Phone, RotateCcw, Signal, Wifi } from "lucide-react";
import { PillButton } from "@/components/marketing/navbar";
import { SIGN_UP_URL } from "@/lib/auth/routes";
import styles from "./landing.module.css";

type CallState = "ringing" | "connected" | "booked" | "declined";
const conversation = [
  { who: "Maya", text: "Hi Elena, I’m Maya, the AI assistant for Sunday Studio. Calling about your appointment tomorrow." },
  { who: "Elena", text: "Oh, could we do Saturday instead?" },
  { who: "Maya", text: "Of course. There’s an opening at 4:15. Does that work for you?" },
  { who: "Elena", text: "That’s perfect. Thank you!" },
];

export function CallStory() {
  const [state, setState] = useState<CallState>("ringing");
  const [seconds, setSeconds] = useState(0);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reminder, setReminder] = useState(false);
  const connected = state === "connected";
  const booked = state === "booked";

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    const complete = window.setTimeout(() => setState("booked"), 14000);
    return () => { window.clearInterval(interval); window.clearTimeout(complete); };
  }, [connected]);

  function answer() { setSeconds(0); setState("connected"); }
  function reset() { setSeconds(0); setState("ringing"); setReminder(false); setReplyOpen(false); }

  return (
    <>
      <section className={styles.heroGrid} aria-label="A day with Callzie">
        <div className={styles.intro}>
          <p className={styles.eyebrow}><span className={styles.liveDot} /> YOUR AI CALLING ASSISTANT</p>
          <h1>Your hands are full.<br /><em>Let Maya make the call.</em></h1>
          <p className={styles.lead}>You do your thing. Maya calls your customers, finds a time<br className={styles.desktopBreak} /> that works, and puts it in the calendar. One less thing.</p>
          <div className={styles.heroActions}>
            <PillButton href={SIGN_UP_URL} size="lg">Get your time back <ArrowUpRight size={18} aria-hidden /></PillButton>
            <a href="#what-you-get">Follow one little call <ArrowDown size={16} aria-hidden /></a>
          </div>
        </div>

        <div className={styles.phoneTile}>
          <div className={styles.tileTop}><span>02 / THE CALL</span><span className={styles.demoLabel}>INTERACTIVE DEMO</span></div>
          <div className={styles.phoneStage}>
            <div className={styles.phone}>
              <div className={styles.phoneScreen}>
                <div className={styles.phoneStatus}><span>9:41</span><span><Signal size={13} fill="currentColor" /><Wifi size={14} /><i className={styles.battery} /></span></div>
                <div className={styles.island} aria-hidden><i /></div>
                <div className={styles.caller}>
                  <p>{connected ? `00:${String(seconds).padStart(2, "0")}` : booked ? "call ended" : state === "declined" ? "call declined" : "incoming call"}</p>
                  <h2>Sunday Studio</h2>
                  <span>{connected ? "Maya is speaking" : "Maya · calling assistant"}</span>
                </div>
                <div className={`${styles.callerAvatar} ${connected ? styles.avatarActive : ""}`}><Image src="/maya-avatar.png" alt="Maya, the AI calling assistant" fill sizes="94px" /></div>
                {booked ? (
                  <div className={styles.phoneConfirmation}><span><Check size={24} /></span><h3>See you Saturday.</h3><p>4:15 PM · Cut & finish</p><button onClick={reset}><RotateCcw size={14} /> Replay the call</button></div>
                ) : state === "declined" ? (
                  <div className={styles.phoneConfirmation}><h3>Life happens.</h3><p>Maya flags the call for follow-up.</p><button onClick={reset}><RotateCcw size={14} /> Try again</button></div>
                ) : connected ? (
                  <div className={styles.activeCall}>
                    <div className={styles.waveform} aria-hidden>{Array.from({ length: 23 }, (_, i) => <i key={i} />)}</div>
                    <p className={styles.liveCaption}>{seconds < 3 ? "“Hi Elena, I’m Maya from Sunday Studio.”" : seconds < 6 ? "“Could we do Saturday instead?”" : seconds < 9 ? "“There’s an opening at 4:15.”" : "“That’s perfect. Thank you!”"}</p>
                    <button className={styles.endCall} onClick={() => setState("declined")} aria-label="End demo call"><Phone size={24} fill="currentColor" /></button>
                    <span>End</span>
                  </div>
                ) : (
                  <div className={styles.phoneControls}>
                    <div className={styles.callUtilities}>
                      <button onClick={() => setReminder((value) => !value)} aria-pressed={reminder}><Bell size={19} /><span>{reminder ? "Reminder set" : "Remind me"}</span></button>
                      <button onClick={() => setReplyOpen((value) => !value)} aria-pressed={replyOpen}><MessageCircle size={19} /><span>{replyOpen ? "Close message" : "Message"}</span></button>
                    </div>
                    {replyOpen && <p className={styles.messagePreview}>“Can’t talk now. Please call later.” <button onClick={() => setState("declined")}>Use reply</button></p>}
                    <div className={styles.answerControls}>
                      <button onClick={() => setState("declined")}><span className={styles.decline}><Phone size={26} fill="currentColor" /></span><span>Decline</span></button>
                      <button onClick={answer} aria-label="Accept demo call"><span className={styles.accept}><Phone size={26} fill="currentColor" /></span><span>Accept</span></button>
                    </div>
                  </div>
                )}
                <div className={styles.homeIndicator} aria-hidden />
              </div>
            </div>
          </div>
          <p className={styles.phoneHint} role="status">{state === "ringing" ? "Go on. Pick up. It’s one less thing." : connected ? "A little conversation. A lot off your plate." : booked ? "And just like that, it’s taken care of." : "Every call has a next step."}</p>
        </div>

        <figure className={styles.lifeTile}>
          <Image src="/salon-story.png" alt="A stylist absorbed in cutting a customer's hair in a sunlit salon" fill sizes="(max-width: 700px) 100vw, 40vw" priority />
          <figcaption><span>01 / YOUR AFTERNOON</span><h2>In your element.<br />Not on the phone.</h2></figcaption>
          <span className={styles.photoTime}>Tuesday, 2:38 pm</span>
        </figure>

        <article className={styles.handoffTile}>
          <div className={styles.tileTop}><span>MEET YOUR EXTRA PAIR OF HANDS</span><ArrowUpRight size={17} aria-hidden /></div>
          <div className={styles.mayaMark} aria-hidden><i /><i /><i /><i /><i /></div>
          <div><h2>Leave it <br />with Maya.</h2><p>The follow-ups. The reschedules.<br />The “just checking in.”<br />She’s got them.</p></div>
          <span className={styles.availability}><span className={styles.liveDot} /> Ready when you are</span>
        </article>
      </section>

      <section id="what-you-get" className={styles.storySection}>
        <div className={styles.storyHeading}><p className={styles.eyebrow}>HERE’S HOW THAT LITTLE CALL PLAYS OUT</p><h2>From “could we move it?”<br /><em>to “see you Saturday.”</em></h2><p>An illustrative call for Sunday Studio.<br />Answer the phone above to watch it unfold.</p></div>
        <div className={styles.outcomeGrid}>
          <article className={styles.conversationTile}>
            <div className={styles.tileTop}><span>03 / A REAL CONVERSATION</span><span className={styles.transcriptLabel}>{connected ? "● IN PROGRESS" : "SAMPLE TRANSCRIPT"}</span></div>
            <div className={styles.conversation} aria-live="polite" aria-relevant="additions">
              {conversation.map((line, index) => (
                <div key={line.text} className={`${styles.chatLine} ${line.who === "Elena" ? styles.customerLine : ""} ${connected && seconds < index * 3 ? styles.pendingLine : ""}`}>
                  <span>{line.who === "Maya" ? "m." : "e."}</span><div><span>{line.who}</span><p>{line.text}</p></div>
                </div>
              ))}
            </div>
            <p className={styles.transcriptFoot}><CheckCheck size={17} /> She checks your real availability as she talks.</p>
          </article>
          <article className={`${styles.bookingTile} ${booked ? styles.bookingComplete : ""}`}>
            <div className={styles.tileTop}><span>04 / ALL TAKEN CARE OF</span><CalendarDays size={19} aria-hidden /></div>
            <div className={styles.bookingTitle}><span className={styles.bookingCheck}><Check size={23} /></span><h3>{connected ? "Finding the right time." : "A new time. All sorted."}</h3><p>And you didn’t have to lift a finger.</p></div>
            <div className={styles.calendarPaper}>
              <div className={styles.calendarHead}><span>Saturday</span><span>YOUR CALENDAR <ChevronRight size={12} /></span></div>
              <div className={styles.calendarSlot}><span>15:30</span><div /></div>
              <div className={styles.calendarSlot}><span>16:15</span><div className={styles.appointment}><strong>Elena · Cut & finish</strong><span>16:15 – 17:00</span><small><Check size={12} /> {booked ? "Rescheduled by Maya" : "Example rescheduled booking"}</small></div></div>
              <div className={styles.calendarSlot}><span>17:00</span><div /></div>
            </div>
            <p className={styles.calendarFoot}><span className={styles.googleG} aria-hidden>G</span> Right there in your Google Calendar.</p>
          </article>
        </div>
      </section>
    </>
  );
}
