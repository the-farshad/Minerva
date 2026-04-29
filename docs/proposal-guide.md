# Research proposal helper

Reference for the structure, page limits, and common pitfalls of major research-funding proposals. Pairs with the **Proposals** section preset (Settings → Add a section → Proposals) and the **AI assistant** ⌘/Ctrl+J (built-in *NSF*, *NIH*, *ERC* prompts).

> *None of this replaces the funder's official solicitation.* Rules change yearly; always check the most recent program announcement (the Proposal Title's `funder` column links there). This is a starting checklist, not a binding contract.

---

## Common to all proposals

A reviewer who finishes your proposal in 30 minutes should be able to answer:

1. **What is the question** in one sentence?
2. **Why now?** What's changed in the field that makes this the right time?
3. **Why you?** What unique capability, data, or prior work makes this team the right one?
4. **What would success look like?** Concrete, falsifiable, time-bounded.
5. **What could go wrong, and what's the fallback?**

Make this answerable from the abstract alone if you can. The body of the proposal is the proof.

---

## NSF — National Science Foundation (US)

The standard structure (per the *Proposal & Award Policies & Procedures Guide*, "PAPPG"):

| Section | Page limit | Must contain |
|---|---|---|
| **Project Summary** | 1 page | Three labeled subsections: **Overview**, **Intellectual Merit**, **Broader Impacts**. The two-merit-criteria paragraphs are mandatory and explicit headings. |
| **Project Description** | **15 pages** (some programs differ — check) | Objectives, prior work, methods, timeline, *and* a dedicated **Broader Impacts** discussion (separate from the summary). NSF reviewers scan for the explicit phrase. |
| **References Cited** | no limit | Standard biblio; counts toward overall but not the 15-page Project Description limit. |
| **Biographical Sketches** | 3 pages per senior person, NSF-fillable form | Now uses the SciENcv-generated PDF format. |
| **Budget Justification** | 5 pages | Per-line dollar rationale; multi-year roll-up. |
| **Current and Pending Support** | no limit | Every proposal under review or active anywhere. |
| **Facilities, Equipment & Other Resources** | no limit | What you have access to that doesn't appear in the budget. |
| **Data Management Plan** | 2 pages | Required for every proposal. What data, how shared, when. |
| **Postdoc Mentoring Plan** | 1 page | Only if the proposal includes postdocs. |

Two NSF-specific traps:
- **Intellectual Merit / Broader Impacts must be labeled** in BOTH the summary and the body. Reviewers literally check.
- **Format compliance is hard-rejected.** 11pt font, 1-inch margins, line spacing per PAPPG.

---

## NIH — National Institutes of Health (US)

NIH submissions are structured around the **Specific Aims** page, which carries enormous weight:

| Section | Page limit | Must contain |
|---|---|---|
| **Specific Aims** | **1 page** (hard) | The whole proposal's argument. Three aims is conventional. State the long-term goal, the gap, the central hypothesis, and what each aim will deliver. **Read by every reviewer.** |
| **Research Strategy** | **12 pages for R01**, 6 for R21, varies by mechanism | Three labeled subsections: **Significance**, **Innovation**, **Approach**. Each has its own scoring criterion. |
| **Bibliography & References** | no limit | |
| **Biographical Sketch** | 5 pages | NIH-format with personal statement + contributions to science. |
| **Budget** | varies | Modular for ≤$250K/yr direct; detailed otherwise. |
| **Resource Sharing Plan** | 2 pages | Data and model-organism sharing. |
| **Authentication of Key Resources** | 1 page | When applicable (cell lines, reagents). |
| **Vertebrate Animals / Human Subjects** | as needed | Required wherever applicable. |

NIH-specific traps:
- The **Approach** section is what review panels argue about. Spend disproportionate effort here; describe pitfalls and alternatives for every aim.
- **Aims must not depend on each other** — if Aim 1 fails, Aims 2–3 should still be doable.
- **Significance ≠ Innovation.** Significance = "why does this matter for human health?" Innovation = "what's new about the approach?" Don't conflate.

---

## ERC — European Research Council

The ERC is *PI-centric* — they fund people, not consortia.

| Section | Page limit | Must contain |
|---|---|---|
| **Part B1: Extended Synopsis** | **5 pages** | The core science argument. Uploaded with the initial submission. |
| **Part B1: CV + Track Record** | **2 + 2 pages** | Standardized CV format; Track Record covers significant publications, invited talks, prizes, supervision. **Heavily weighted.** |
| **Part B2: Scientific Proposal** | **14 pages** | Only requested if you pass Step 1. Detailed methodology, work packages, timeline, resources. |
| **Ethics + Security** | tables | Self-assessment; flagging any concerns up front avoids surprises in evaluation. |

ERC-specific traps:
- **Demonstrate ground-breaking nature explicitly.** ERC's only criterion is *scientific excellence* — high-risk / high-gain framing is expected, not punished.
- **The PI's track record drives Step 1** more than the science. Be honest and specific about your own contributions on multi-author papers.
- **Five publications max** in the track record's "10 publications" subsection get reviewer attention; pick them carefully.

---

## DOE — Department of Energy (US)

DOE Office of Science proposals (BES, BER, ASCR, FES, HEP, NP) typically follow:

- **Project Narrative**: 20 pages (varies by program), ≥ 11 pt, 1-inch margins.
- **Bibliography**: separate, no limit.
- **Biographical Sketches**: NSF-style.
- **Current and Pending Support**: required.
- **Facilities**: detailed, especially when using user facilities (LCLS, NSLS-II, etc.).

DOE-specific traps:
- **Mission alignment is explicit.** Your proposal must point to a specific paragraph in DOE's BES (or relevant) mission statement and explain how your work advances it.
- **National lab partnerships** require special structure (subaward language, work-for-others agreements).

---

## Internal / institutional / foundation proposals

Variable. Common minimum sections:

- **Title + 1-paragraph summary**
- **Specific aims or goals** (3–5 bullet points usually fine)
- **Methods** (1–2 pages)
- **Timeline** with milestones
- **Budget**
- **CV / track record** (sometimes none; sometimes 2-page bio)

For foundations specifically: check whether they fund *projects* or *people*. Gates, MacArthur, HHMI, Sloan all skew toward people. Frame accordingly.

---

## Pre-submission checklist (last 48 hours)

- [ ] Specific Aims / Project Summary fits in one page and states the question, the gap, and the deliverables in plain language.
- [ ] Every aim/objective has at least one explicit pitfall + alternative approach.
- [ ] Broader Impacts (NSF) or Significance (NIH) is **labeled with the literal phrase** in both summary and body.
- [ ] Page limits, font, line spacing, and margins are conformant. Run the funder's compliance check tool if one exists.
- [ ] Every figure has a caption. Every figure is referenced from the text.
- [ ] References are formatted to the funder's spec (NSF requires last name + first initial only; NIH allows full names).
- [ ] Budget total matches the project narrative's stated effort.
- [ ] All co-investigators have signed off on their roles and effort percentages.
- [ ] Data Management Plan is present and specific.
- [ ] Conflicts of interest list is current.
- [ ] You've read the proposal aloud start to finish in one sitting.

---

## How Minerva supports this

The **Proposals** section preset (Settings → Add a section → Proposals) has columns for the standard sections, deadline tracking, and status. Each proposal is a row.

The **AI assistant** (⌘/Ctrl+J) has built-in prompts:

- *Proposal — NSF / NIH / ERC structure*: explain the format and rules.
- *Proposal — critique my abstract*: paste your abstract, get a reviewer-style critique.
- *Proposal — broader impacts brainstorm*: generate ideas given your project's domain.

For draft-by-draft tracking: clone the proposal row and increment the status field. The status `select(...)` drives a filter (`status:!=submitted`) so the active drafts always sit at the top. The `deadline` column drives sort order and feeds the iCal feed alongside tasks — your calendar app will start nagging you a week out automatically.
