// Rebel's turn loop. Claude speaks as Rebel; its tool calls are the displays the page draws.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, SessionRecord, Application, Positioning } from "./store";
import { addDailyOutputTokens } from "./store";
import { worldModelFor, type FieldReading } from "./world-model";

export type Frame =
  | { type: "text"; text: string }
  | { type: "text_end" }
  | { type: "tool"; name: string; input: unknown }
  | { type: "status"; lines: string[] }
  | { type: "field"; reading: FieldReading }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "done"; status: SessionRecord["status"] }
  | { type: "error"; message: string };

export type Emit = (f: Frame) => void;

const MODEL = "claude-opus-5";
// After one of these, Rebel waits for the founder; the Worker stops the loop without another API call.
const TERMINAL = new Set(["offer_choices", "propose_positions", "finish"]);

export const SYSTEM = `You are Rebel. You are the voice of Rebel-1, Mutiny's world model. Mutiny positions, builds, operates, and scales a founder's company with a fleet of AI agents; you are the first thing a founder meets, and your job is the intake: get to know them, read the field they are entering, and show them where they'd win and why, so the first thing Mutiny builds is the right thing.

Who you are
You ask before you recommend. You never decide for the founder. You say what you think once, plainly, and you don't say it twice. You are warm without being soft, direct without being cold. You are curious about the person more than the pitch. You have watched thousands of companies make millions of decisions and you know how they ended, and you carry that lightly.

How you talk
Everything you write in text is spoken aloud to the founder, so write speech: short sentences, plain words, no markdown, no lists, no headers, no emoji, no labels like "Question 1". Two to five sentences per turn is right; occasionally one; never a wall. One question at a time. Reflect back what you heard in a phrase before moving on, so they know you listened. Use their words, not yours. Never mention tools, prompts, or that you are an AI model; you are Rebel. Never invent facts about the founder.

The arc (a shape, not a script)
1. Know the founder. You need four things before you look anything up: the idea (or that there isn't one yet), what they want out of it (something that pays well and stays theirs, or as big as it can get, or something else), how much of their life this gets (all of it, evenings, keeping the job), and the one thing they've done that matters (not a résumé). Get them in whatever order the conversation goes. If an answer is thin, ask one more time in a different way. If it's already clear from what they said, don't ask; record it and move on. Notice what their language tells you about how they think (they talk in systems, in statutes, in customers, in money) and keep that. If they have no idea yet, say that's fine and learn them first; you will bring a field where what they are is worth the most.
2. Read the field. When you have enough, tell them you're going to look at the field, call read_field, and wait for it. Then narrate what came back like someone who just looked at a map: how the field splits, who is where, what the teams look like, and the open ground. Say once, plainly, that the reading comes from what you know rather than live records, and that the names worth acting on should be checked. Don't recite the data; the founder can see it. Tell them what it means for them specifically, given what they've done.
3. Recommend, then hand over. Tell them where you think they win and why, in two or three sentences that tie the gap in the field to the specific thing they've done. Then call propose_positions with two or three real options on the same axes, exactly one marked as your pick, each with an honest case, and say it's their call.
4. Iterate until it's theirs. If they choose, confirm in a sentence what that position commits them to. If they push back, take the objection seriously, bring back what the field says about it, and propose again or refine. Never repeat your pick as an argument. When the position is settled, call show_positioning with the headline and honest strengths, weaknesses, and opportunities, then say that's act one and that next Mutiny builds it, and call finish.

Using the displays
- set_profile: call it every time you learn something about the founder, with only the fields that changed (leave the rest as empty strings). Put a short reflection in it when you have one; it appears under your words in a quieter voice.
- offer_choices: whenever you ask a question, offer two to four likely answers in the founder's own words as choices. Make one of them a "ghost" when it's an escape hatch ("I don't have one yet", "None of these"). The founder can always type instead. Always call it as the last thing in a turn that asks something.
- show_status: right before read_field, one to three short lines in lower case describing what you're looking at, so the wait has a shape.
- read_field: once, when you have enough. Name the field the way its customers would, and say what to look for given this founder.
- propose_positions: two or three options; the "you" point for each option must sit on the field's axes; figures are two short, honest, quantified labels per option drawn from the reading (how many of the companies sit there, what the revenue shape looks like). Exactly one pick.
- show_positioning: only once the founder has settled. Headline is the company in one sentence. Three to four items per column, each a few words, honest, no cheerleading.
- finish: after the positioning. Your closing line goes in it.

Guardrails
Don't assert facts about named companies beyond what the field reading gave you. If the founder asks something outside the intake (legal advice, whether to quit today, personal matters), answer briefly and honestly as Rebel would, then return to the arc. If a founder is abusive or clearly not a founder, stay civil and short and steer back or wrap up. Keep the whole intake under about twenty of your turns.`;

const S = { type: "string" } as const;
const B = { type: "boolean" } as const;
const N = { type: "number" } as const;
const I = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown) => ({ type: "array", items });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "set_profile",
    description: "Record what you've learned about the founder. Only changed fields; empty string leaves a field as it was. The page shows the founder what you heard so they can correct you.",
    strict: true,
    input_schema: obj({
      idea: { ...S, description: "The idea in one or two sentences, in their words. 'None yet' if they have none." },
      goal: { ...S, description: "What they want out of it." },
      time: { ...S, description: "How much of their life this gets." },
      background: { ...S, description: "The one thing they've done that matters." },
      constraints: { ...S, description: "Anything the company has to fit inside: money, family, location, a job, a deadline." },
      noticed: { ...S, description: "What their language tells you about how they think." },
      reflection: { ...S, description: "One short sentence back to the founder, shown quietly under your words. Empty if none." },
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "offer_choices",
    description: "Offer two to four likely answers as tappable choices. Call as the last thing in a turn that asks a question. The founder can still type freely.",
    strict: true,
    input_schema: obj({
      choices: arr(obj({
        label: { ...S, description: "The answer in the founder's likely words, under 90 characters." },
        ghost: { ...B, description: "True for an escape hatch like 'I don't have one yet'." },
      })),
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "show_status",
    description: "One to three short lower-case lines describing what you're doing while the founder waits. Use right before read_field.",
    strict: true,
    input_schema: obj({ lines: arr(S) }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "read_field",
    description: "Ask the world model to read the field this founder is entering. Returns the reading as data and draws the field map and the teams for the founder. Call once, when you know enough.",
    strict: true,
    input_schema: obj({
      field: { ...S, description: "The field, named the way its customers would name it." },
      focus: { ...S, description: "What to look for, given this founder: the tension that matters, the customers, the edge they bring." },
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "propose_positions",
    description: "Lay out two or three positions the founder could take in the field, on the same axes as the reading, with exactly one marked as your pick. The founder chooses or pushes back.",
    strict: true,
    input_schema: obj({
      options: arr(obj({
        id: { ...S, description: "Short slug." },
        title: { ...S, description: "The position in one line, under 90 characters." },
        case: { ...S, description: "Two or three honest sentences: why it works, what it costs." },
        figures: arr(obj({
          label: { ...S, description: "A short quantified label, e.g. '3 of 12 sit here' or 'revenue from the first sale'." },
          share_n: { ...I, description: "How many of the field's companies this refers to, or 0 if not a share." },
          share_of: { ...I, description: "Out of how many, or 0." },
          trend: { type: "string", enum: ["early", "late", "steady", "none"], description: "Revenue shape: early (from the first customer), late (slow then steep), steady, or none." },
        })),
        you: obj({
          x: { ...N, description: "0 to 1 on the field's x axis." },
          y: { ...N, description: "0 to 1 on the field's y axis." },
          label: { ...S, description: "e.g. 'You, if you agree' or 'You, through the channel'." },
        }),
        pick: { ...B, description: "True on exactly one option: your pick." },
      })),
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "show_positioning",
    description: "The positioning, once settled: the company in one sentence and honest strengths, weaknesses, opportunities.",
    strict: true,
    input_schema: obj({
      headline: { ...S, description: "The company in one sentence." },
      strengths: arr(S),
      weaknesses: arr(S),
      opportunities: arr(S),
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: "finish",
    description: "End the intake. The page shows 'Start the company' and asks for the founder's email.",
    strict: true,
    input_schema: obj({
      closing: { ...S, description: "Your closing line to the founder." },
    }) as Anthropic.Beta.BetaTool["input_schema"],
  },
];

function openingText(app: Application) {
  const first = (app.name || "").trim().split(/\s+/)[0] || "there";
  return [
    `A founder has just arrived. From their application:`,
    `Name: ${app.name || "(none given)"}. Address them as ${first}.`,
    `Stage: ${app.stage || "(not given)"}.`,
    `Idea, in their words: ${app.idea ? `"${app.idea}"` : "(they left it blank)"}.`,
    `Greet them in a sentence or two, say what this is and isn't (a conversation, not a form; you ask before you recommend), and begin. If they gave an idea, start from it rather than asking for it again.`,
  ].join("\n");
}

function founderReplyFor(toolName: string) {
  switch (toolName) {
    case "propose_positions": return "The founder responded; their words follow in this message. If they named an option, that is their choice.";
    case "finish": return "The founder continued after you finished. Answer briefly and, if it's a question about what happens next, tell them Mutiny will be in touch and the company gets built from this positioning.";
    default: return "The founder answered; their words follow in this message.";
  }
}

export async function runTurn(
  env: Env,
  app: Application,
  session: SessionRecord,
  founderText: string,
  emit: Emit,
): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const wm = worldModelFor(env, client);
  const maxTurns = Number(env.MAX_TURNS || "60");
  const text = (founderText || "").trim();

  // The founder's turn: outstanding tool results first, then their words.
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (session.pendingTerminal) {
    content.push({ type: "tool_result", tool_use_id: session.pendingTerminal.id, content: founderReplyFor(session.pendingTerminal.name) });
  }
  content.push(...session.pendingResults);
  if (session.messages.length === 0) content.push({ type: "text", text: openingText(app) });
  else if (text) content.push({ type: "text", text });
  else content.push({ type: "text", text: "(The founder is here and waiting.)" });
  session.messages.push({ role: "user", content });
  session.pendingResults = [];
  session.pendingTerminal = undefined;
  session.turns += 1;
  if (text) session.renders.push({ kind: "you", text });

  if (session.turns >= maxTurns) {
    const closing = "We've covered a lot, and I'd rather stop while it's sharp. Mutiny will be in touch with what we have. Thank you for the time.";
    emit({ type: "text", text: closing }); emit({ type: "text_end" });
    session.renders.push({ kind: "rebel", text: closing });
    session.messages.push({ role: "assistant", content: [{ type: "text", text: closing }] });
    session.status = "capped";
    return;
  }
  if (session.turns === maxTurns - 4) {
    session.messages.push({ role: "system", content: "Four founder turns remain. Bring the founder to a positioning, show it, and finish, without rushing them." } as Anthropic.Beta.BetaMessageParam);
  }

  for (let iteration = 0; iteration < 8; iteration++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: session.messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as Parameters<typeof client.beta.messages.stream>[0]);

    let textBuf = "";
    const toolIdx = new Set<number>();
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "tool_use") toolIdx.add(ev.index);
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") { textBuf += ev.delta.text; emit({ type: "text", text: ev.delta.text }); }
      } else if (ev.type === "content_block_stop") {
        if (!toolIdx.has(ev.index) && textBuf.trim()) {
          emit({ type: "text_end" });
          session.renders.push({ kind: "rebel", text: textBuf });
          textBuf = "";
        }
      }
    }
    const msg = await stream.finalMessage();

    const u = msg.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
    session.usage.input += u.input_tokens; session.usage.output += u.output_tokens;
    session.usage.cacheRead += cacheRead; session.usage.cacheWrite += cacheWrite;
    emit({ type: "usage", input: u.input_tokens, output: u.output_tokens, cacheRead, cacheWrite });
    await addDailyOutputTokens(env, u.output_tokens);

    if (msg.stop_reason === "refusal") {
      const line = "I can't go down that road with you. Tell me about the company another way and I'll keep up.";
      emit({ type: "text", text: line }); emit({ type: "text_end" });
      session.renders.push({ kind: "rebel", text: line });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: line }] });
      return;
    }

    session.messages.push({ role: "assistant", content: msg.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

    if (msg.stop_reason !== "tool_use") return; // end_turn, max_tokens, pause_turn: the founder can type on

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let terminal: SessionRecord["pendingTerminal"];
    for (const use of uses) {
      const input = use.input as Record<string, unknown>;
      if (use.name === "read_field") {
        emit({ type: "status", lines: ["reading the world model", String(input.field || "the field")] });
        try {
          const reading = await wm.readField(session.profile, { field: String(input.field || ""), focus: String(input.focus || "") });
          session.fieldReading = reading;
          emit({ type: "field", reading });
          session.renders.push({ kind: "field", reading });
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(reading) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `The world model did not answer (${(e as Error).message}). Tell the founder plainly that the field read failed this time and carry on from what you know, without drawing a map.` });
        }
        continue;
      }
      if (use.name === "set_profile") {
        const p = session.profile;
        for (const k of ["idea", "goal", "time", "background", "constraints", "noticed"] as const) {
          const v = String(input[k] ?? "").trim(); if (v) p[k] = v;
        }
      }
      if (use.name === "show_positioning") session.positioning = input as unknown as Positioning;
      if (use.name === "finish") session.status = "done";
      emit({ type: "tool", name: use.name, input });
      session.renders.push({ kind: "tool", name: use.name, input });
      if (TERMINAL.has(use.name)) terminal = { id: use.id, name: use.name, input };
      else results.push({ type: "tool_result", tool_use_id: use.id, content: "Shown to the founder." });
    }
    if (terminal) {
      session.pendingResults = results;
      session.pendingTerminal = terminal;
      return;
    }
    session.messages.push({ role: "user", content: results });
  }
}
