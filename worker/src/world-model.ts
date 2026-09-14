// The world model seam. Rebel asks one question of it: "read the field for this founder."
// v1 answers from Claude's own knowledge. The real Rebel-1 world model plugs in behind the same interface.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, FounderProfile } from "./store";

export type TeamToken = { kind: "founder" | "eng" | "sales" | "ops"; n: number };
export type FieldCompany = {
  name: string;
  x: number; // 0..1 along axes.x, left to right
  y: number; // 0..1 along axes.y, bottom to top
  size: number; // 1 small, 2 mid, 3 large
  note: string; // one line: what they sell and to whom
  team: TeamToken[];
  highlight: boolean; // the ones that matter most to this founder
  confidence: "known" | "unsure";
};
export type FieldReading = {
  field: string; // the field, named the way its customers would name it
  title: string; // the one-line verdict, e.g. "Everyone sells the form. Nobody fights the fight."
  sub: string; // two or three sentences on how the field splits
  axes: { x: [string, string]; y: [string, string] }; // [left, right], [bottom, top]
  companies: FieldCompany[];
  gaps: string[]; // open positions and why they are open
  teamsTakeaway: string; // what the teams have in common, and what they lack that this founder has
  source: string; // where this reading came from
  caveat: string; // what to distrust about it
};

export type ReadFieldRequest = { field: string; focus: string };

export interface WorldModel {
  readField(profile: FounderProfile, req: ReadFieldRequest): Promise<FieldReading>;
}

const FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["field", "title", "sub", "axes", "companies", "gaps", "teamsTakeaway"],
  properties: {
    field: { type: "string" },
    title: { type: "string" },
    sub: { type: "string" },
    axes: {
      type: "object",
      additionalProperties: false,
      required: ["x_left", "x_right", "y_bottom", "y_top"],
      properties: {
        x_left: { type: "string" },
        x_right: { type: "string" },
        y_bottom: { type: "string" },
        y_top: { type: "string" },
      },
    },
    companies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "x", "y", "size", "note", "team", "highlight", "confidence"],
        properties: {
          name: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          size: { type: "integer", enum: [1, 2, 3] },
          note: { type: "string" },
          team: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "n"],
              properties: {
                kind: { type: "string", enum: ["founder", "eng", "sales", "ops"] },
                n: { type: "integer" },
              },
            },
          },
          highlight: { type: "boolean" },
          confidence: { type: "string", enum: ["known", "unsure"] },
        },
      },
    },
    gaps: { type: "array", items: { type: "string" } },
    teamsTakeaway: { type: "string" },
  },
} as const;

const WM_SYSTEM = `You are the field-reading function of Rebel-1, Mutiny's world model. Given a founder and the field they are entering, you return a reading of that field as structured data. You are precise, unsentimental, and honest about what you do not know.

How to read a field:
- Name the field the way its customers would, not the way analysts would.
- Choose the two axes that actually separate winners from the rest in THIS field. Not "price vs quality". Real tensions: who the product works for, what it charges for, whether it does the work or hands over a tool, where in the workflow it sits. Write each axis end as a short phrase (2 to 5 words).
- List 8 to 14 companies that are actually in the field. Use real, nameable companies where they exist. Never invent a company. If you are not confident a company exists or does what you say, set confidence to "unsure" and say so in its note. If you know fewer than 8 real companies, return fewer.
- Position each company on the axes (0 to 1). Size 3 for the largest or best-funded, 1 for small.
- Team composition: your best understanding of how the company is staffed, as rough counts by kind. This is a sketch, not a census.
- Highlight the 2 to 4 companies that matter most to this founder's idea.
- Gaps: 2 to 4 positions in the field where nobody sits, each with the reason it is open (nobody has the skill, the economics look bad but aren't, incumbents can't move there without breaking their model).
- teamsTakeaway: one or two sentences on what the teams in the field have in common and what none of them have that this founder does.
- title: one line, plain, memorable, the shape of the field in a sentence.
- sub: two or three sentences on how the field splits.

Write like a sharp operator talking, not a report. No hedging filler. Return only the structured reading.`;

export class ClaudeKnowledgeWorldModel implements WorldModel {
  constructor(private client: Anthropic) {}
  async readField(profile: FounderProfile, req: ReadFieldRequest): Promise<FieldReading> {
    const founder = [
      `Idea: ${profile.idea || "(not stated)"}`,
      `What they want from it: ${profile.goal || "(not stated)"}`,
      `Time they can give it: ${profile.time || "(not stated)"}`,
      `What they have done: ${profile.background || "(not stated)"}`,
      profile.constraints ? `Constraints: ${profile.constraints}` : "",
      profile.noticed ? `What Rebel noticed: ${profile.noticed}` : "",
    ].filter(Boolean).join("\n");
    const stream = this.client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: { effort: "high", format: { type: "json_schema", schema: FIELD_SCHEMA } },
      system: WM_SYSTEM,
      messages: [{
        role: "user",
        content: `Field to read: ${req.field}\nWhat to look for: ${req.focus}\n\nThe founder:\n${founder}`,
      }],
    });
    const msg = await stream.finalMessage();
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const raw = JSON.parse(text) as {
      field: string; title: string; sub: string;
      axes: { x_left: string; x_right: string; y_bottom: string; y_top: string };
      companies: FieldCompany[]; gaps: string[]; teamsTakeaway: string;
    };
    const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
    return {
      field: raw.field,
      title: raw.title,
      sub: raw.sub,
      axes: { x: [raw.axes.x_left, raw.axes.x_right], y: [raw.axes.y_bottom, raw.axes.y_top] },
      companies: raw.companies.slice(0, 14).map((c) => ({ ...c, x: clamp(c.x), y: clamp(c.y), size: Math.min(3, Math.max(1, Math.round(c.size))) })),
      gaps: raw.gaps,
      teamsTakeaway: raw.teamsTakeaway,
      source: "Model knowledge",
      caveat: "Read from model knowledge, not live records. Names and teams are Rebel's best understanding; check the ones that matter.",
    };
  }
}

// The real world model. Same shape over HTTP; not wired until WORLD_MODEL=rebel and WORLD_MODEL_URL are set.
export class RebelWorldModel implements WorldModel {
  constructor(private url: string) {}
  async readField(profile: FounderProfile, req: ReadFieldRequest): Promise<FieldReading> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/read-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, request: req }),
    });
    if (!res.ok) throw new Error(`world model ${res.status}`);
    return (await res.json()) as FieldReading;
  }
}

export function worldModelFor(env: Env, client: Anthropic): WorldModel {
  if (env.WORLD_MODEL === "rebel" && env.WORLD_MODEL_URL) return new RebelWorldModel(env.WORLD_MODEL_URL);
  return new ClaudeKnowledgeWorldModel(client);
}
