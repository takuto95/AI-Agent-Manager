import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: 'You are a test bot.' },
          { role: 'user', content: 'Hello. Respond with only OK' }
        ]
      })
    });

    const data = await res.json();

    return NextResponse.json({
      success: true,
      reply: data.choices[0].message.content
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        error: e.message
      },
      { status: 500 }
    );
  }
}
