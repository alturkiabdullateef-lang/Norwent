import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TickerTape from "./components/TickerTape";
import CommandBar from "./components/CommandBar";
import TradeChart, { type ChartPlan } from "./components/TradeChart";
import LessonPanel from "./components/LessonPanel";
import { EventLog, PlanPanel, type TradeEvent } from "./components/PlanPanel";
import { CheatSheet, ConceptDeck, Lifecycle } from "./components/LearnSection";
import { LESSONS } from "./lib/lessons";
import { PRESETS } from "./lib/presets";
import {
  detectInstrument,
  fmt,
  fmtKr,
  parseCommand,
  type ParseResult,
  type Side,
} from "./lib/parser";
import {
  mulberry32,
  seedCandles,
  seedVol,
  tickCandles,
  tickVol,
  type Candle,
  type Drift,
} from "./lib/market";

const WORD_FOR_LESSON: Record<string, string> = {
  buy: "KÖP",
  sell: "SÄLJ",
  sl: "SL",
  tp: "TP",
  hold: "HOLD",
  rr: "RR",
};

const SPEEDS = [
  { label: "Paus", value: 0 },
  { label: "1×", value: 1 },
  { label: "3×", value: 3 },
  { label: "6×", value: 6 },
];

const now = () =>
  new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const BOOT = parseCommand(PRESETS[0].command);
const BOOT_PLAN: ChartPlan = {
  side: BOOT.side,
  entry: BOOT.entry,
  sl: BOOT.sl,
  slOrigin: BOOT.sl,
  tps: BOOT.tps,
  hold: false,
};
const BOOT_INST = detectInstrument(BOOT.entry);

export default function App() {
  const [input, setInput] = useState(PRESETS[0].command);
  const [result, setResult] = useState<ParseResult | null>(BOOT);
  const [plan, setPlanState] = useState<ChartPlan | null>(BOOT_PLAN);
  const [lessonId, setLessonId] = useState("buy");
  const [account, setAccount] = useState(25000);
  const [riskPct, setRiskPct] = useState(1);
  const [candles, setCandles] = useState<Candle[]>(() =>
    seedCandles(BOOT.entry!, seedVol(BOOT.entry, BOOT.sl), 68, 4242)
  );
  const [speed, setSpeed] = useState(1);
  const [hits, setHits] = useState({ sl: false, tps: [false, false, false] });
  const [closed, setClosed] = useState(false);
  const [closedR, setClosedR] = useState(0);
  const [autoBE, setAutoBE] = useState(true);
  const [instrument, setInstrument] = useState(BOOT_INST);
  const [events, setEvents] = useState<TradeEvent[]>([
    {
      id: 0,
      time: now(),
      text: `Exempelplan laddad · KÖP ${fmt(BOOT.entry, BOOT_INST.decimals)} · SL ${fmt(
        BOOT.sl,
        BOOT_INST.decimals
      )} · tre mål`,
      tone: "buy",
    },
  ]);

  const planRef = useRef<ChartPlan | null>(BOOT_PLAN);
  const hitsRef = useRef({ sl: false, tps: [false, false, false] });
  const closedRef = useRef(false);
  const drift = useRef<Drift>({ v: 0.4 });
  const rnd = useRef(mulberry32(20260214));
  const evId = useRef(1);
  const dashRef = useRef<HTMLDivElement>(null);

  const setPlan = useCallback((p: ChartPlan | null) => {
    planRef.current = p;
    setPlanState(p);
  }, []);

  const log = useCallback((text: string, tone: TradeEvent["tone"]) => {
    setEvents((e) => [{ id: evId.current++, time: now(), text, tone }, ...e].slice(0, 40));
  }, []);

  const live = candles[candles.length - 1]?.c ?? 0;
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const decimals = instrument.decimals;

  /* ---------- simulering ---------- */
  const vol = useMemo(
    () => tickVol(plan?.entry, plan?.slOrigin ?? plan?.sl),
    [plan?.entry, plan?.sl, plan?.slOrigin]
  );

  useEffect(() => {
    if (speed === 0) return;
    const id = window.setInterval(() => {
      setCandles((prev) => tickCandles(prev, vol, rnd.current, drift.current));
    }, Math.round(420 / speed));
    return () => window.clearInterval(id);
  }, [speed, vol]);

  /* ---------- nivåträffar ---------- */
  useEffect(() => {
    const p = planRef.current;
    if (!p || !p.side || !p.entry || p.hold || closedRef.current) return;
    const riskDist = Math.abs(p.entry - (p.slOrigin ?? p.sl ?? p.entry));
    if (riskDist <= 0) return;
    const dir = p.side === "BUY" ? 1 : -1;
    const units = ((account * riskPct) / 100) / riskDist;

    p.tps.forEach((tp, i) => {
      if (tp === undefined || hitsRef.current.tps[i] || closedRef.current) return;
      if ((tp - p.entry!) * dir <= 0) return; // fel sida om ingången
      if ((live - tp) * dir >= 0) {
        hitsRef.current = {
          ...hitsRef.current,
          tps: hitsRef.current.tps.map((v, k) => (k === i ? true : v)),
        };
        setHits({ ...hitsRef.current });
        const r = Math.abs(tp - p.entry!) / riskDist;
        log(
          `TP${i + 1} nådd vid ${fmt(tp, decimals)} → +${r.toFixed(1).replace(".", ",")}R (${fmtKr(
            Math.abs(tp - p.entry!) * units
          )})`,
          "buy"
        );
        if (i === 0 && autoBE && p.sl !== p.entry) {
          const moved = { ...p, sl: p.entry };
          planRef.current = moved;
          setPlanState(moved);
          log("SL flyttad till ingång → resten av positionen är riskfri", "gold");
        }
      }
    });

    if (p.sl !== undefined && !hitsRef.current.sl) {
      if ((live - p.sl) * dir <= 0) {
        const lossR = Math.abs(p.sl - p.entry) / riskDist;
        hitsRef.current = { ...hitsRef.current, sl: true };
        closedRef.current = true;
        setHits({ ...hitsRef.current });
        setClosed(true);
        setClosedR(-lossR);
        setSpeed(1);
        log(
          lossR < 0.01
            ? `SL (break even) utlöst vid ${fmt(p.sl, decimals)} → 0R. Trade'n stängd utan förlust.`
            : `SL utlöst vid ${fmt(p.sl, decimals)} → −${lossR
                .toFixed(1)
                .replace(".", ",")}R (${fmtKr(-((account * riskPct) / 100) * lossR)}). Positionen är stängd.`,
          lossR < 0.01 ? "gold" : "sell"
        );
      }
    }
  }, [live, account, riskPct, decimals, log, autoBE]);

  /* ---------- kör kommando ---------- */
  const applyPlan = useCallback(
    (p: ChartPlan, note?: string) => {
      const prev = planRef.current;
      const reseed = !prev || prev.entry !== p.entry;
      const inst = detectInstrument(p.entry);
      setInstrument(inst);
      setPlan(p);

      if (reseed) {
        hitsRef.current = { sl: false, tps: [false, false, false] };
        closedRef.current = false;
        setHits({ sl: false, tps: [false, false, false] });
        setClosed(false);
        setClosedR(0);
        setCandles(seedCandles(p.entry!, seedVol(p.entry, p.slOrigin ?? p.sl), 68, Math.floor(rnd.current() * 1e6)));
        drift.current = { v: p.side === "SELL" ? -0.4 : 0.4 };
        const parts = [
          `${p.side === "SELL" ? "SÄLJ" : "KÖP"} ${fmt(p.entry, inst.decimals)}`,
          p.slOrigin !== undefined ? `SL ${fmt(p.slOrigin, inst.decimals)}` : "SL saknas",
          p.tps.some((t) => t !== undefined)
            ? `TP ${p.tps.map((t) => (t ? fmt(t, inst.decimals) : "—")).join(" / ")}`
            : "TP saknas",
        ];
        log(`${parts.join(" · ")} — ${inst.symbol}`, p.side === "SELL" ? "sell" : "buy");
      } else if (note) {
        log(note, "gold");
      }
    },
    [log, setPlan]
  );

  const runCommand = useCallback(
    (raw: string) => {
      const res = parseCommand(raw);
      setResult(res);
      setInput(raw);

      if (res.riskPct !== undefined) {
        setRiskPct(Math.min(5, Math.max(0.25, res.riskPct)));
        log(`Risk per trade satt till ${res.riskPct.toFixed(2).replace(".", ",")} %`, "info");
      }
      if (res.account !== undefined) {
        setAccount(res.account);
        log(`Konto satt till ${fmtKr(res.account)}`, "info");
      }

      const hasNumbers =
        res.entry !== undefined ||
        res.sl !== undefined ||
        res.tps.some((t) => t !== undefined) ||
        res.riskPct !== undefined ||
        res.account !== undefined;

      /* --- lektionsläge: bara ett ord --- */
      if (!hasNumbers) {
        const id = res.lessonId;
        if (!id) {
          log(`Okänt kommando: ”${raw}” — prova KÖP, SÄLJ, SL, TP1, HOLD eller RR`, "info");
          return;
        }
        setLessonId(id);
        const lesson = LESSONS[id];
        if (id === "buy" || id === "sell") {
          const preset = id === "buy" ? PRESETS[0] : PRESETS[1];
          const demo = parseCommand(preset.command);
          applyPlan({
            side: demo.side,
            entry: demo.entry,
            sl: demo.sl,
            slOrigin: demo.sl,
            tps: demo.tps,
            hold: false,
          });
        } else if (id === "hold") {
          const prev = planRef.current;
          setPlan(
            prev
              ? { ...prev, hold: true }
              : { entry: liveRef.current, tps: [undefined, undefined, undefined], hold: true }
          );
          log("HOLD — ingen ny position. Villkor: vänta på stängning över/under nivån.", "hold");
        } else {
          log(`${lesson.term} — förklaring öppnad (${lesson.english})`, "gold");
        }
        return;
      }

      /* --- planläge: merga med det som redan finns --- */
      const prev = planRef.current;
      const inferred: Side | undefined =
        res.sl !== undefined && (res.entry ?? prev?.entry) !== undefined
          ? (res.sl ?? prev?.sl)! < (res.entry ?? prev?.entry)!
            ? "BUY"
            : "SELL"
          : res.tps[0] !== undefined && (res.entry ?? prev?.entry) !== undefined
            ? res.tps[0]! > (res.entry ?? prev?.entry)!
              ? "BUY"
              : "SELL"
            : undefined;

      const side = res.side ?? prev?.side ?? inferred;
      const entry = res.entry ?? prev?.entry ?? liveRef.current;
      const sl = res.sl ?? prev?.sl;
      const slOrigin = res.sl !== undefined ? res.sl : (prev?.slOrigin ?? prev?.sl);
      const tps = res.tps.map((v, i) => v ?? prev?.tps[i]);

      const changed: string[] = [];
      if (res.side) changed.push(res.side === "BUY" ? "KÖP" : "SÄLJ");
      if (res.entry !== undefined) changed.push(`ingång ${fmt(res.entry, decimals)}`);
      if (res.sl !== undefined) changed.push(`SL ${fmt(res.sl, decimals)}`);
      res.tps.forEach((t, i) => t !== undefined && changed.push(`TP${i + 1} ${fmt(t, decimals)}`));
      if (res.hold) changed.push("HOLD");

      const lessonFor =
        res.sl !== undefined
          ? "sl"
          : res.tps.some((t) => t !== undefined)
            ? "tp"
            : res.hold
              ? "hold"
              : res.side === "SELL"
                ? "sell"
                : res.side === "BUY"
                  ? "buy"
                  : undefined;
      if (lessonFor) setLessonId(lessonFor);
      applyPlan(
        {
          side,
          entry,
          sl,
          slOrigin,
          tps,
          hold: res.side ? false : res.hold || (prev?.hold ?? false),
        },
        changed.length ? `Uppdaterad: ${changed.join(", ")}` : undefined
      );
      if (!side) log("Riktning saknas — skriv KÖP eller SÄLJ så vet jag var SL hör hemma.", "info");
      else if (sl === undefined) log("SL saknas — utan stopp har du ingen känd risk.", "sell");
      else if (!tps.some((t) => t !== undefined))
        log("TP saknas — sätt minst ett mål, gärna tre.", "gold");
    },
    [applyPlan, decimals, log, setPlan]
  );

  const pickLesson = useCallback(
    (id: string) => {
      setLessonId(id);
      const word = WORD_FOR_LESSON[id] ?? id.toUpperCase();
      const res = parseCommand(word);
      setResult(res);
      setInput(word);
      log(`${LESSONS[id].term} — förklaring öppnad`, "gold");
      dashRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [log]
  );

  const reset = useCallback(() => {
    const p = planRef.current;
    if (!p || !p.entry) {
      setCandles(seedCandles(liveRef.current, 0.0009, 68, Math.floor(rnd.current() * 1e6)));
      return;
    }
    const restored: ChartPlan = { ...p, sl: p.slOrigin ?? p.sl, hold: false };
    hitsRef.current = { sl: false, tps: [false, false, false] };
    closedRef.current = false;
    setHits({ sl: false, tps: [false, false, false] });
    setClosed(false);
    setClosedR(0);
    setPlan(restored);
    setCandles(seedCandles(p.entry, seedVol(p.entry, p.slOrigin ?? p.sl), 68, Math.floor(rnd.current() * 1e6)));
    log("Ny runda — grafen nollställd till ingången", "info");
  }, [log, setPlan]);

  /* ---------- härledda värden ---------- */
  const riskDist = plan?.entry && (plan.slOrigin ?? plan.sl) !== undefined
    ? Math.abs(plan.entry - (plan.slOrigin ?? plan.sl)!)
    : 0;
  const riskKr = (account * riskPct) / 100;
  const units = riskDist > 0 ? riskKr / riskDist : 0;
  const dir = plan?.side === "SELL" ? -1 : 1;
  const openR = plan?.entry && riskDist > 0 ? ((live - plan.entry) * dir) / riskDist : 0;
  const openKr = plan?.entry ? (live - plan.entry) * dir * units : 0;

  const status = closed
    ? {
        text:
          closedR > -0.01
            ? "BREAK EVEN · 0R"
            : `STOPPAD ${closedR.toFixed(1).replace(".", ",")}R`,
        tone: closedR > -0.01 ? "var(--color-gold)" : "var(--color-sell)",
      }
    : plan?.hold
      ? { text: "HOLD · avvaktar", tone: "var(--color-hold)" }
      : plan?.side && plan.entry
        ? { text: "POSITION AKTIV", tone: "var(--color-buy)" }
        : { text: "INGEN PLAN", tone: "var(--color-fog)" };

  const levels: { key: string; label: string; value?: number; tone: string; r?: number; hit?: boolean }[] = [
    { key: "e", label: "Ingång", value: plan?.entry, tone: "var(--color-gold)" },
    {
      key: "sl",
      label: "SL",
      value: plan?.slOrigin ?? plan?.sl,
      tone: "var(--color-sell)",
      r: -1,
      hit: hits.sl,
    },
    ...plan?.tps.map((t, i) => ({
      key: `tp${i}`,
      label: `TP${i + 1}`,
      value: t,
      tone: "var(--color-buy)",
      r: riskDist > 0 && plan?.entry && t !== undefined ? ((t - plan.entry) * dir) / riskDist : undefined,
      hit: hits.tps[i],
    })) ?? [],
  ];

  return (
    <div className="bg-terminal noise relative min-h-screen">
      <div className="grid-lines pointer-events-none absolute inset-x-0 top-0 h-[720px] opacity-40 [mask-image:linear-gradient(180deg,#000,transparent)]" />

      <div className="relative">
        <TickerTape />

        {/* ---------- huvud ---------- */}
        <header className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-md border border-edge2 bg-panel">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" strokeWidth="1.8">
                <path d="M5 4v16M5 8h0" stroke="var(--color-sell)" strokeLinecap="round" />
                <rect x="3" y="8" width="4" height="7" rx="1" fill="var(--color-sell)" />
                <path d="M12 2v20" stroke="var(--color-buy)" strokeLinecap="round" />
                <rect x="10" y="6" width="4" height="9" rx="1" fill="var(--color-buy)" />
                <path d="M19 6v14" stroke="var(--color-gold)" strokeLinecap="round" />
                <rect x="17" y="10" width="4" height="6" rx="1" fill="var(--color-gold)" />
              </svg>
            </span>
            <div>
              <div className="font-display text-[20px] leading-none font-extrabold tracking-tight text-chalk">
                TRADE<span className="text-gold">LAB</span>
              </div>
              <div className="mt-1 font-mono text-[10px] tracking-[0.2em] text-fog uppercase">
                skriv kommandot · se planen · lär dig nivåerna
              </div>
            </div>
          </div>

          <nav className="hidden items-center gap-1 md:flex">
            {[
              ["Grafen", "#dash"],
              ["Byggstenar", "#byggstenar"],
              ["Flöde", "#flode"],
              ["Cusklapp", "#fusklapp"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded px-3 py-1.5 font-mono text-[11px] tracking-[0.1em] text-fog uppercase transition-colors hover:bg-panel2 hover:text-gold"
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 rounded-full border border-edge bg-panel/70 px-3 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-halo rounded-full bg-buy" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-buy" />
            </span>
            <span className="font-mono text-[10.5px] tracking-[0.14em] text-fog uppercase">
              simulerad feed
            </span>
          </div>
        </header>

        {/* ---------- kommando + dashboard ---------- */}
        <main id="dash" ref={dashRef} className="mx-auto w-full max-w-[1400px] scroll-mt-4 px-4 pb-6 sm:px-6">
          <CommandBar value={input} onChange={setInput} onSubmit={runCommand} result={result} />

          {result?.message && result.status !== "ok" && (
            <div className="anim-pop mt-3 flex items-start gap-2.5 rounded-md border border-gold/40 bg-gold/8 px-3.5 py-2.5">
              <span className="mt-0.5 text-gold">
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="8" cy="8" r="6.4" />
                  <path d="M8 5v3.6M8 10.8v.2" strokeLinecap="round" />
                </svg>
              </span>
              <p className="font-mono text-[12px] leading-relaxed text-chalk/90">{result.message}</p>
            </div>
          )}

          <div className="mt-4 grid gap-3 lg:grid-cols-12">
            {/* vänster: graf + siffror */}
            <div className="space-y-3 lg:col-span-8">
              <section className="overflow-hidden rounded-lg border border-edge bg-panel/80">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge/70 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div>
                      <div className="font-display text-[18px] leading-none font-extrabold text-chalk">
                        {instrument.symbol}
                      </div>
                      <div className="mt-1 font-mono text-[9.5px] tracking-[0.14em] text-fog uppercase">
                        {instrument.name} · 1 min · simulerad
                      </div>
                    </div>
                    <div className="border-l border-edge pl-4">
                      <div
                        className="font-mono text-[26px] leading-none font-semibold tabular-nums transition-colors duration-300"
                        style={{ color: openR >= 0 ? "var(--color-buy)" : "var(--color-sell)" }}
                      >
                        {fmt(live, decimals)}
                      </div>
                      <div className="mt-1.5 font-mono text-[11px] tabular-nums" style={{ color: openR >= 0 ? "var(--color-buy)" : "var(--color-sell)" }}>
                        {openR >= 0 ? "+" : ""}
                        {openR.toFixed(2).replace(".", ",")}R ·{" "}
                        {openR >= 0 ? "+" : "−"}
                        {fmtKr(Math.abs(openKr))}
                      </div>
                    </div>
                    <span
                      className="rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-[0.16em] uppercase"
                      style={{ color: status.tone, borderColor: `${status.tone}55`, background: `${status.tone}12` }}
                    >
                      {status.text}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAutoBE((v) => !v)}
                      title="Flytta SL till ingången när TP1 träffas"
                      className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 font-mono text-[10px] tracking-[0.1em] uppercase transition-colors"
                      style={{ color: autoBE ? "var(--color-gold)" : "var(--color-fog)", borderColor: autoBE ? "rgba(247,183,51,.45)" : "var(--color-edge)" }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: autoBE ? "var(--color-gold)" : "var(--color-edge2)" }}
                      />
                      auto break-even
                    </button>
                    <div className="flex overflow-hidden rounded border border-edge">
                      {SPEEDS.map((s) => (
                        <button
                          key={s.label}
                          onClick={() => setSpeed(s.value)}
                          className={`px-2 py-1 font-mono text-[10.5px] transition-colors ${
                            speed === s.value
                              ? "bg-chalk text-[#06090e]"
                              : "text-fog hover:bg-panel2 hover:text-chalk"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={reset}
                      className="group flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 font-mono text-[10.5px] text-fog transition-colors hover:border-info/60 hover:text-info"
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3 transition-transform duration-500 group-hover:-rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" strokeLinecap="round" />
                        <path d="M13.6 1.6v2.8h-2.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      kör om
                    </button>
                  </div>
                </div>

                <div className="p-2 sm:p-3">
                  <TradeChart
                    candles={candles}
                    plan={plan}
                    live={live}
                    decimals={decimals}
                    hits={hits}
                  />
                </div>

                {/* nivåremsa */}
                <div className="flex flex-wrap gap-1.5 border-t border-edge/70 bg-[#0a1017] px-3 py-2.5">
                  {levels.map((l) => (
                    <div
                      key={l.key}
                      className="flex items-center gap-2 rounded border px-2 py-1 transition-all duration-300 hover:-translate-y-0.5"
                      style={{
                        borderColor: l.value !== undefined ? `${l.tone}44` : "var(--color-edge)",
                        background: l.hit ? `${l.tone}1a` : "transparent",
                        boxShadow: l.hit ? `0 0 18px -6px ${l.tone}` : "none",
                      }}
                    >
                      <span className="font-mono text-[9.5px] tracking-[0.14em] uppercase" style={{ color: l.tone }}>
                        {l.label}
                      </span>
                      <span className="font-mono text-[12px] font-semibold text-chalk tabular-nums">
                        {fmt(l.value, decimals)}
                      </span>
                      {l.r !== undefined && (
                        <span className="font-mono text-[10px]" style={{ color: l.tone }}>
                          {l.r > 0 ? "+" : ""}
                          {l.r.toFixed(1).replace(".", ",")}R
                        </span>
                      )}
                      {l.hit && (
                        <span className="font-mono text-[9.5px] font-bold" style={{ color: l.tone }}>
                          ✓ träffad
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid gap-3 lg:grid-cols-12">
                <div className="lg:col-span-7">
                  <PlanPanel
                    plan={plan}
                    decimals={decimals}
                    account={account}
                    riskPct={riskPct}
                    onAccount={setAccount}
                    onRisk={setRiskPct}
                  />
                </div>
                <div className="lg:col-span-5">
                  <EventLog events={events} />
                </div>
              </div>
            </div>

            {/* höger: lektion */}
            <div className="lg:col-span-4">
              <div className="lg:sticky lg:top-4">
                <LessonPanel
                  lesson={LESSONS[lessonId] ?? null}
                  status={result?.headline ?? "REDO"}
                  message={result?.message}
                  activeId={lessonId}
                  onPick={pickLesson}
                  onRun={(cmd) => {
                    runCommand(cmd);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </div>
            </div>
          </div>
        </main>
      </div>

      <div id="byggstenar">
        <ConceptDeck onPick={pickLesson} />
      </div>
      <div id="flode">
        <Lifecycle onPick={pickLesson} />
      </div>
      <div id="fusklapp">
        <CheatSheet
          onRun={(cmd) => {
            runCommand(cmd);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>

      <footer className="relative border-t border-edge bg-[#070b10]">
        <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-10 sm:px-6 md:grid-cols-3">
          <div>
            <div className="font-display text-[17px] font-extrabold text-chalk">
              TRADE<span className="text-gold">LAB</span>
            </div>
            <p className="mt-2 max-w-xs text-[12.5px] leading-relaxed text-fog">
              En pedagogisk simulator för att förstå hur en trade byggs: riktning, skydd, mål och
              tålamod. Priserna är simulerade — inget här är finansiell rådgivning.
            </p>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] text-fog uppercase">
              Tangenter
            </div>
            <ul className="mt-2.5 space-y-1.5 font-mono text-[11.5px] text-fog">
              <li>
                <kbd className="rounded border border-edge2 px-1.5 py-0.5 text-chalk">Enter</kbd> kör
                kommandot
              </li>
              <li>
                <kbd className="rounded border border-edge2 px-1.5 py-0.5 text-chalk">Esc</kbd> rensar
                fältet
              </li>
              <li>
                <kbd className="rounded border border-edge2 px-1.5 py-0.5 text-chalk">/</kbd> fokuserar
                kommandofältet
              </li>
            </ul>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] text-fog uppercase">
              Kom ihåg
            </div>
            <p className="mt-2.5 font-display text-[19px] leading-snug font-bold text-chalk">
              Risken bestäms av SL-avståndet,
              <br />
              inte av hur mycket du vill vinna.
            </p>
            <a
              href="#dash"
              className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] text-gold transition-all hover:gap-3"
            >
              tillbaka till grafen
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 13V3M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
