# RainDB Starter -- Source Vision Transcript

This file is the extracted, verbatim record of the conversation where the
RainDB Starter ("Yoda starter app") scope was defined. It is the source of
truth behind `docs/STARTER_HANDOFF.md`.

- **Source machine**: `192.168.10.15` (`~/.local/share/opencode/opencode.db`)
- **Session**: `ses_133d29e0cffe54aV9D7fk0Dgiv` ("Restore cyclone markdown from git")
- **Anchor keywords**: `starfield`, `yoda`
- **Low watermark (topic start)**: user msg `msg_ece8f2366001B7xNXU17KbBB3K` -- 2026-06-16 03:52:27 UTC
- **High watermark (topic actively discussed)**: assistant msg `msg_ece8f2785001ODNeY8u1xlVRtD` -- 2026-06-16 03:54:32 UTC
- **Move-on point**: msg `msg_ece90fa8c001b4jjLfT1FiawFG` -- the agent dispatches the
  registration-flow build (Steps 2-5); the Yoda starter (Step 6b) is explicitly
  deferred to "a SEPARATE agent/repo I'll run." After this the thread is about the
  registration funnel and `raindb-cli`, not the starter app.

The relevant material is **Step 6** of the user's writeup (the starter app), plus the
agent's reflection of it, plus two later clarifications about how to treat the spec.

---

## [LOW WATERMARK] USER -- the full writeup (msg_ece8f2366, 03:52:27)

> right now the registration flow is not correct. The "workspace" landing page is
> great with the "creaet your first group" and the invitations and all that, but we
> need to add an extra registration flow. let me explain.
>
> Step 1. User enters invitation code -> Signup Tier options become available
> Path A) Person gets Email Registration Link with Code from Invitation
> Path B) Person goes to /register and enters code
>
> Step 2. User selects Tier -> Goes to Signup
> - This tier needs to follow the registration, you will see why, perhaps in the url
>   or a cookie? whatever is most standard for this
>
> Step 3. User signs up username/password -> successful signup changes status of
> invitation token -> Goes to Create Company/Group Name
> - Shouldn't be an empty page, should use the same headline font as the "RainDB is
>   invitation-only right now." and "Start free. Scale when you do." but it should say
>   something like "
> - say something like "Welcome, you're one of the lucky ones! Signup, let's go!"
>
> Step 4. Creates group [new page] -> goes to Create Tenant
> - Says, "Enter your Organization or Group Name." in smaller letters under it says,
>   "You will be able to add more members in your workspace."
>
> Step 5. Create Tenant [ new page ] -> Project Startup [ new page ]
> - "Create your first RainDB Project." in smaller if they have free tier selected say
>   "Aren't you a developer? Come on.. let's go!" if they have developer selected or
>   switch to developer it should say, "Let's go! Your AI Agent is going to love this!
>   I mean, you, you are going to love this!", any other tier just say, "Welcome! I'm
>   looking forward to working with you and your AI Agent!"
> - show the user's choice at the top in a slick spacex way showing their options
> - Field for the user to enter the tenant name which will create the first tenant with
>   the selected pricing
> - Show the pricing module underneath for them to change their mind and choose a
>   different one.
>
> Step 6. Project Startup [ new page ] -> Continue to project Portal
> - This page should have links to download the raindb-cli install script which should
>   copy other pages that have the "click" button to copy/paste the bash install command
>   for linux/macos, and it needs to have the download binaries for mac or linux or
>   windows we will have to compile the raindb-cli for windows too. The click "install"
>   should ask for the raindb username and password (safely) and use the raindb-cli to
>   setup the users tenant profiles automatically
> - There should be download AGENTS.md which gives the agents everything they need to
>   know about how to use rainDB and to use the raindb-cli marketplace for examples and
>   general formation knowledge and patterns and lightning/bolt deployment details. I've
>   started a few projects to begin this but I think the starter became too complex, i
>   have thought about this some more. **It should be a simple "hello world" but the
>   screen instead of saying "hello world" it should be an AI Agent chatbot with a cool
>   starwars intro like starfield that is subtle but cool and has AI agent responses at
>   the top in starwars like lettering that fades off into the distance slowly, and the
>   user can type and have a conversation with it. It's basic to get the bolt up and
>   running and the AI Agent going. and it could have a notes widget for taking notes,
>   and you should be able to turn on and off the star field to make it a normal chat
>   interface where the user can do the searches and discuss the note cards. So it's
>   basically the same application as the /home/ryan/src/raindb-starter but just I want
>   it really clean and sort of cool and imediately gratifying with the ai agent saying
>   something very "Hello world" and yoda and something to do with RainDB and perhaps
>   even relvant to a recent note that they entered if they have, so the chat bot will
>   have a yoda personality. There we go, that's cool.**
>
> Step 7. Tenant Portal [ exists ]
>
> ---
>
> What do you think about all this? i'm okay with you working with agents to get all of
> this done and help them along the way. If other agents need instructions how to deploy
> lightning bolts to work on the starter application and other things you could ask your
> other agent that knows how to deploy the raindb-app and you could use what it says to
> train other agents. But hopefully the starter README.md is sufficient, that's the goal
> of that project. You should tell the agent that works on that to make sure to deploy
> and test with rtest environment not production right now.

---

## [HIGH WATERMARK] ASSISTANT -- reflection of the vision (msg_ece8f2785, 03:52:41 -> 03:54:32)

> This is a great, coherent end-to-end onboarding vision. Let me reflect it back to
> confirm I've got it, then say what I think and how I'd sequence it.
>
> ## What I'm hearing -- the full registration flow
>
> 1. **Enter invite code** -> tiers unlock (Path A: email link with code; Path B:
>    `/register` + code). *Already built.*
> 2. **Select tier** -> carried through the whole flow (URL param or cookie -- I'll use
>    whichever is cleanest/standard).
> 3. **Signup user/pass** -> invite token flips to `activated` -> land on a styled
>    "Welcome, you're one of the lucky ones!" page (same headline font as the hero), not
>    an empty page.
> 4. **Create Group** page -- "Enter your Organization or Group Name" + subtext "You will
>    be able to add more members in your workspace."
> 5. **Create Tenant** page -- headline "Create your first RainDB Project." + tier-aware
>    subcopy (Free->"Aren't you a developer? Come on.. let's go!"; Developer->"Let's go!
>    Your AI Agent is going to love this!..."; others->"Welcome! I'm looking forward to
>    working with you and your AI Agent!"), the chosen tier shown SpaceX-style at top, a
>    tenant-name field (creates tenant on the selected tier), and the pricing module below
>    to change their mind.
> 6. **Project Startup** page -- raindb-cli install (copy bash one-liners for linux/macOS,
>    binary downloads incl. a Windows build we'll need to compile; an "Install" action
>    that securely takes raindb user/pass and runs raindb-cli to auto-configure tenant
>    profiles), a downloadable `AGENTS.md`, and a clean **"hello world" starter = a
>    Yoda-personality AI agent chatbot** with a subtle Star Wars starfield + fading
>    crawl-style responses, a notes widget, starfield on/off toggle, immediate
>    gratification (Yoda greeting tied to RainDB / a recent note). Basically
>    `raindb-starter` but clean and cool.
> 7. **Tenant Portal** -- *exists.*
>
> ## What I think
>
> - **Steps 1-5 are the launch-critical path** and are mostly additive to what exists
>   (you already have invite-unlock, tier selection, and the workspace/group/tenant
>   creation -- this is reordering + tier-threading + styled pages). High value, well-
>   defined, low risk. I'd do these first with the raindb-app agent.
> - **Step 6 has two very different pieces:** (a) the install/AGENTS.md page is
>   straightforward; (b) the **Yoda starfield chatbot starter** is a whole creative app
>   (its own bolt deploy, AI agent wiring, starfield UI). That's the biggest, fuzziest
>   chunk -- I'd scope it as its own track with a separate agent working in
>   `raindb-starter`, deploying to **rtest only**, and I'll feed it deployment know-how
>   from the raindb-app agent.
> - **One thing to decide:** tier carry-through. I'll use a **URL param through the flow**
>   (`?plan=developer`) as the primary, since it survives refresh and is shareable/
>   standard; a cookie as backup. Good?
>
> ## How I'd sequence it
> 1. **raindb-app agent** builds Steps 2-5 (tier threading + the 4 styled pages: Welcome
>    -> Create Group -> Create Tenant w/ tier display + pricing-to-change -> into portal),
>    deploy rtest, I verify the full funnel->signup->group->tenant->portal end-to-end with
>    capabilities minting on the chosen tier.
> 2. **Then** Step 6a (install/AGENTS.md page) on raindb-app.
> 3. **Separate agent** on `raindb-starter` for Step 6b (the Yoda chatbot starter),
>    rtest-only, README-driven; I'll supply bolt-deploy guidance from the raindb-app agent.
>
> One question to nail the tier-aware Create-Tenant copy and the broader UX before I
> dispatch:

*(The assistant then asked a `question` tool prompt about tier carry-through, wrote a
`REGISTRATION_FLOW_BUILD_SPEC.md`, and at 03:54:32 dispatched the raindb-app agent on
Steps 2-5 -- the **move-on point**. From here the conversation is about the registration
funnel and `raindb-cli`, NOT the starter app.)*

---

## [LATER CLARIFICATIONS] -- how to treat the spec (still applicable to the starter)

**USER (msg_eceb2319a, 04:30:45):**

> these requirements are more focused on the raindb itself, the raindb-app and other
> typescript/bolt efforts aren't as critical

**USER (msg_eceb31ef0, 04:31:45):**

> also please review what I provided you and you ccan normalize it with industry best
> practices, I like to provide options that doesn't mean it has to work that way if
> there's a more natural pattern

**USER (in the original writeup, repeated for emphasis -- the rtest rule):**

> You should tell the agent that works on that to make sure to deploy and test with
> rtest environment not production right now.

---

## Distilled intent (the starter app only -- "Step 6b")

1. The starter is the **"new age hello world"** for RainDB: get a bolt + AI agent live
   fast, with immediate gratification.
2. The hero is **an AI agent chatbot with a Yoda personality**, not a static "hello
   world." Its greeting ties to RainDB and (if present) a recent note the user wrote.
3. Visual signature: **a subtle Star Wars starfield** with agent responses rendered as
   **fading Star Wars-style crawl lettering** receding into the distance.
4. A **starfield on/off toggle** flips it into a normal, clean chat interface where the
   user can search and discuss note cards.
5. A **notes widget** (note cards) for capturing notes -- the data the agent is grounded
   in.
6. **Clean and simple.** The previous starter "became too complex." This should be small,
   elegant, immediately gratifying -- something a developer is wowed by, plays with, then
   sets aside (or keeps as a reference/easter egg) without it interfering with their own
   build.
7. Structured like a **framework init/starter template** (the "create-react-app"
   experience): clone -> one command -> running.
8. Treat the spec as **intent, not prescription** -- normalize to industry best practices
   where a more natural pattern exists.
9. **Deploy/test against rtest, never production.**
