import sql from "@/utils/db"
import Router from "koa-router"
import { Context } from "koa"
import stripe from "@/utils/stripe"
import { OpenAIStream, StreamingTextResponse } from "ai"
import OpenAI from "openai"
import { completion } from "litellm"

const orgs = new Router({
  prefix: "/orgs/:orgId",
})

orgs.get("/", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const [row] = await sql`
    select
      id,
      created_at,
      plan,
      billing,
      play_allowance,
      limited,
      verified,
      plan_period,
      canceled,
      stripe_customer,
      stripe_subscription,  
      name
    from
      org
    where
      id = ${orgId}
  `

  ctx.body = row
})

orgs.patch("/", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const name = (ctx.request.body as { name: string }).name

  await sql`
      update org
      set
        name = ${name}
      where
        id = ${orgId}
    `
  ctx.body = {}
})

orgs.get("/projects", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const rows = await sql`
    select
      id,
      created_at,
      name,
      org_id,
      exists(select * from run where app = app.id) as activated
    from
      app
    where
      org_id = ${orgId}
  `

  ctx.body = rows
})

orgs.get("/usage", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string
  const { projectId } = ctx.request.query

  const rows = await sql`
    select
      date_trunc('day', r.created_at) as date,
      count(*) as count
    from
      run r 
    ${!projectId ? sql`join app a on r.app = a.id` : sql``}
    where
      ${!projectId ? sql`a.org_id = ${orgId} and` : sql``}
      ${projectId ? sql`r.app = ${projectId} and` : sql``}
      r.created_at > now() - interval '30 days'
    group by
      date
    order by
    date desc;
  `

  ctx.body = rows
})

orgs.post("/upgrade", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const { plan, period, origin } = ctx.request.body as {
    plan: string
    period: string
    origin: string
  }

  const lookupKey = `${plan}_${period}`

  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
  })

  if (prices.data.length === 0) {
    throw new Error("No price found for this plan and period")
  }

  const priceId = prices.data[0].id as string

  const [org] = await sql`
    select
      id,
      plan,
      stripe_customer,
      stripe_subscription
    from
      org
    where
      id = ${orgId}
  `

  if (!org) throw new Error("Org not found")

  if (!org.stripe_subscription) {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      client_reference_id: orgId,
      customer: org.stripeCustomer || undefined,
      metadata: {
        plan,
        period,
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${origin}/billing/thank-you`,
      cancel_url: `${origin}/billing`,
    })

    return (ctx.body = { ok: true, url: checkoutSession.url })
  } else {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscription,
    )

    const subItem = subscription.items.data[0].id

    // Update user subscription with new price
    await stripe.subscriptions.update(org.stripeSubscription, {
      cancel_at_period_end: false,
      metadata: {
        plan,
        period,
      },
      items: [
        {
          id: subItem,
          price: priceId,
        },
      ],
    })

    // Update org plan
    await sql`
      update org
      set
        plan = ${plan}
      where
        id = ${orgId}
    `
  }

  ctx.body = { ok: true }
})

const OPENROUTER_MODELS = [
  "mistralai/mistral-7b-instruct",
  "openai/gpt-4-32k",
  "openchat/openchat-7b",
  "teknium/openhermes-2.5-mistral-7b",
  "mistralai/mixtral-8x7b-instruct",
  "open-orca/mistral-7b-openorca",
  "perplexity/pplx-70b-chat",
  "perplexity/pplx-7b-chat",
  "google/gemini-pro",
  "google/palm-2-chat-bison",
  "meta-llama/llama-2-13b-chat",
  "meta-llama/llama-2-70b-chat",
]

const ANTHROPIC_MODELS = ["claude-2", "claude-2.0", "claude-instant-v1"]

const convertInputToOpenAIMessages = (input: any[]) => {
  return input.map(({ role, content, text, functionCall, toolCalls, name }) => {
    return {
      role: role.replace("ai", "assistant"),
      content: content || text,
      function_call: functionCall || undefined,
      tool_calls: toolCalls || undefined,
      name: name || undefined,
    }
  })
}

// Replace {{variable}} with the value of the variable using regex
const compileTemplate = (
  content: string,
  variables: Record<string, string>,
) => {
  const regex = /{{(.*?)}}/g
  return content.replace(regex, (_, g1) => variables[g1] || "")
}

orgs.post("/playground", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const [org] = await sql`
    select play_allowance
    from org
    where id = ${orgId}
  `

  if (org?.playAllowance <= 0) {
    throw new Error(
      "No allowance left today. Wait tomorrow or upgrade to continue using the playground.",
    )
  }

  // substract play allowance
  await sql`
    update org
    set play_allowance = play_allowance - 1
    where id = ${orgId}
  `

  const { content, extra, testValues } = ctx.request.body as {
    content: any[]
    extra: any
    testValues: Record<string, string>
  }

  let copy = [...content]

  // The template build happens here
  if (testValues) {
    for (const item of copy) {
      item.content = compileTemplate(item.content, testValues)
    }
  }

  const model = extra?.model || "gpt-3.5-turbo"

  const messages = convertInputToOpenAIMessages(copy)

  let method

  if (ANTHROPIC_MODELS.includes(model)) {
    method = completion
  } else {
    const openAIparams = OPENROUTER_MODELS.includes(model)
      ? {
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": "https://lunary.ai",
            "X-Title": `Lunary.ai`,
          },
        }
      : {
          apiKey: process.env.OPENAI_API_KEY,
        }

    const openai = new OpenAI(openAIparams)

    method = openai.chat.completions.create.bind(openai.chat.completions)
  }

  const response = await method({
    model,
    messages,
    temperature: extra?.temperature,
    max_tokens: extra?.max_tokens,
    top_p: extra?.top_p,
    top_k: extra?.top_k,
    presence_penalty: extra?.presence_penalty,
    frequency_penalty: extra?.frequency_penalty,
    stop: extra?.stop,
    functions: extra?.functions,
    tools: extra?.tools,
    seed: extra?.seed,
    stream: true,
  })

  const stream = OpenAIStream(response)

  ctx.response.body = new StreamingTextResponse(stream)
})

export default orgs
