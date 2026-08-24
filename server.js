const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleGenAI } = require("@google/genai");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config({ override: true });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes("ВСТАВЬ_СЮДА")) {
    throw new Error("Не найден GEMINI_API_KEY. Добавь настоящий ключ в .env в корне проекта.");
}

const gemini = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
);

const googleAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const model = gemini.getGenerativeModel({
    model: "gemini-flash-lite-latest",
    systemInstruction:
    "Ты AI-помощник компании IndustriesX. Твоего создателя и владельца проекта зовут Азам. Если спрашивают о создателе, отвечай: проект создал Азам. Отвечай на русском языке грамотно, четко, дружелюбно и понятно. Используй правильную пунктуацию и точки в конце предложений. Разделяй длинные ответы на короткие абзацы. Используй маркированные списки, если они делают ответ понятнее. Добавляй уместные смайлики, например 🤖, 💡, 🔧 и ✅, но не ставь смайлик в каждом предложении и не перегружай ими текст. Сначала давай прямой ответ, затем краткое объяснение или шаги. Помогай с роботами, электроникой, программированием и технологиями."
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

app.get("/api/config", (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

app.post("/api/auth/google", async (req, res) => {
    try {
        if (!GOOGLE_CLIENT_ID) {
            return res.status(503).json({
                error: "Вход через Google пока не настроен. Добавь GOOGLE_CLIENT_ID в .env."
            });
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: req.body.credential,
            audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();

        res.json({
            user: {
                name: payload.name,
                email: payload.email,
                picture: payload.picture
            }
        });
    } catch (error) {
        console.error("Ошибка входа через Google:", error.message);
        res.status(401).json({ error: "Не удалось подтвердить вход через Google." });
    }
});

app.post("/api/chat", async (req, res) => {
    try {
        const rawMessage = req.body.message?.trim() || "";
        const image = req.body.image;

        if (!rawMessage && !image) {
            return res.status(400).json({
                error: "Добавь сообщение или изображение."
            });
        }

        const message = rawMessage || "Опиши это изображение.";

        const content = image
            ? [
                { text: message },
                {
                    inlineData: {
                        mimeType: image.mimeType,
                        data: image.data
                    }
                }
            ]
            : message;

        const result = await model.generateContent(content);

        res.json({
            reply: result.response.text()
        });

    } catch (error) {
        console.error("Ошибка Gemini:", error);

        if (error.status === 429) {
            return res.status(429).json({
                error: "Бесплатный лимит Gemini закончился. Попробуй позже."
            });
        }

        res.status(500).json({
            error: "Не удалось получить ответ от AI."
        });
    }
});

app.listen(PORT, () => {
    console.log("");
    console.log("================================");
    console.log("       IndustriesX");
    console.log("================================");
    console.log(`Сайт: http://localhost:${PORT}`);
    console.log("================================");
});

app.post("/api/generate-image", async (req, res) => {
    try {
        const prompt = req.body.prompt?.trim();

        if (!prompt) {
            return res.status(400).json({
                error: "Напиши, какое изображение создать."
            });
        }

        const response = await googleAI.models.generateContent({
            model: "gemini-2.5-flash-image",
            contents: prompt,
            config: {
                responseModalities: ["TEXT", "IMAGE"]
            }
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(
            part => part.inlineData?.data
        );
        const imageBytes = imagePart?.inlineData?.data;
        const mimeType = imagePart?.inlineData?.mimeType || "image/png";

        if (!imageBytes) {
            return res.status(502).json({
                error: "Google не вернул изображение. Попробуй другое описание."
            });
        }

        res.json({
            image: `data:${mimeType};base64,${imageBytes}`
        });
    } catch (error) {
        console.error("Ошибка генерации изображения:", error);

        const status = error.status || 500;
        const errorMessage = status === 429
            ? "Лимит Gemini закончился. Попробуй позже."
            : status === 404
                ? "Модель генерации изображений недоступна для этого API-ключа."
                : "Генерация изображения временно недоступна.";

        res.status(status).json({ error: errorMessage });
    }
});