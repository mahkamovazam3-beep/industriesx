const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleGenAI } = require("@google/genai");
const { OAuth2Client } = require("google-auth-library");
const { execFile } = require("child_process");
const path = require("path");
require("dotenv").config({ override: true });
const ESP32_IP = process.env.ESP32_IP || "";
let robotStopTimer = null;

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
        const styleInstructions = {
            compact: "Отвечай кратко: сначала прямой ответ, затем только необходимые шаги.",
            formal: "Отвечай строго и профессионально, без эмодзи и лишних вступлений.",
            default: "Отвечай дружелюбно и понятно, используя короткие абзацы и уместные списки."
        };

        if (!rawMessage && !image) {
            return res.status(400).json({
                error: "Добавь сообщение или изображение."
            });
        }

        if (!image) {
            const robotIntent = parseRobotIntent(rawMessage);
            if (robotIntent) {
                try {
                    const robotResult = await executeRobotCommand(robotIntent.command, robotIntent.duration);
                    return res.json({
                        reply: robotResult.message,
                        robot: robotResult
                    });
                } catch (error) {
                    console.error("Ошибка команды роботу:", error.message);
                    return res.status(error.status || 503).json({
                        error: "ESP32 недоступна. Проверь подключение робота к Wi-Fi."
                    });
                }
            }
        }

        const message = (rawMessage || "Опиши это изображение.") + "\n\n" + (styleInstructions[req.body.style] || styleInstructions.default);

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

        if (error.status === 503) {
            return res.status(503).json({ error: error.message });
        }

        if (error instanceof TypeError && error.message === "fetch failed") {
            return res.status(503).json({
                error: "Gemini недоступен по сети. Проверь подключение к интернету."
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

app.post("/api/device-action", (req, res) => {
    const action = req.body.action;
    const projectFolder = __dirname;
    const desktop = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : projectFolder;
    const screenshotPath = path.join(desktop, "mimo-screenshot.png");
    const actions = {
        browser: {
            args: ["/c", "start", "", "https://www.google.com"],
            message: "Браузер открыт."
        },
        music: {
            args: ["/c", "start", "", "https://music.youtube.com"],
            message: "Музыкальный сервис открыт."
        },
        folder: {
            args: ["/c", "start", "", projectFolder],
            message: "Папка проекта открыта."
        },
        mute: {
            args: ["-NoProfile", "-Command", "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Audio { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'; [Audio]::keybd_event(173, 0, 0, [UIntPtr]::Zero)"],
            file: "powershell.exe",
            message: "Звук переключен."
        },
        screenshot: {
            args: ["-NoProfile", "-Command", "$path = '" + screenshotPath.replace(/'/g, "''") + "'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose()"],
            file: "powershell.exe",
            message: "Скриншот сохранен на рабочий стол как mimo-screenshot.png."
        },
        battery: {
            args: ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining)"],
            file: "powershell.exe",
            message: ""
        }
    };

    if (process.platform !== "win32" || !actions[action]) {
        return res.status(400).json({ error: "Это действие недоступно на данном компьютере." });
    }

    const selected = actions[action];
    execFile(selected.file || "cmd.exe", selected.args, { windowsHide: true }, (error, stdout) => {
        if (error) return res.status(500).json({ error: "Не удалось выполнить действие." });
        const message = action === "battery"
            ? (stdout.trim() ? "Заряд батареи: " + stdout.trim() + "%." : "Батарея не обнаружена.")
            : selected.message;
        res.json({ message });
    });
});

// ========================================
// 🤖 УПРАВЛЕНИЕ ESP32-C3
// ========================================

app.post("/api/robot-command", async (req, res) => {
    try {
        const command = req.body.command;
        const duration = Number(req.body.duration) || 0;

        const allowedCommands = [
            "forward",
            "back",
            "left",
            "right",
            "stop"
        ];

        if (!allowedCommands.includes(command)) {
            return res.status(400).json({
                error: "Неизвестная команда робота."
            });
        }

        const result = await executeRobotCommand(command, duration);

        res.json({
            success: result.success,
            command: command,
            duration: result.duration,
            esp32: result.esp32,
            message: result.message
        });

    } catch (error) {
        console.error("Ошибка связи с ESP32:", error.message);

        res.status(503).json({
            error: "ESP32 недоступна. Подключи ноутбук к Wi-Fi робота или укажи IP робота из домашней сети в .env.",
            details: error.message
        });
    }
});

app.get("/api/robot-status", async (req, res) => {
    if (!ESP32_IP) {
        return res.json({ connected: false, error: "ESP32_IP не указан в .env." });
    }

    try {
        const baseUrl = new URL(ESP32_IP);
        if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error("Неверный протокол");
        const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
        res.json({ connected: response.ok, status: response.status });
    } catch (error) {
        res.json({ connected: false, error: error.message });
    }
});

function parseRobotIntent(text) {
    const normalized = text.toLowerCase().replace(/ё/g, "е");
    const isCommand = /(езжай|езжаи|поезжай|поезжаи|двигайся|двигаися|двигаться|ходи|команду|робот|машин)/.test(normalized);
    if (!isCommand) return null;

    const directions = [
        { words: ["вперед", "вперёд"], command: "forward" },
        { words: ["назад"], command: "back" },
        { words: ["влево"], command: "left" },
        { words: ["вправо"], command: "right" },
        { words: ["стоп", "остановись", "останови"], command: "stop" }
    ];
    const direction = directions.find(item => item.words.some(word => normalized.includes(word)));
    if (!direction) return null;

    const durationMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(секунд|секунды|секунду|с)/);
    const duration = durationMatch ? Math.min(Math.max(Number(durationMatch[1].replace(",", ".")), 0.2), 30) : 0;
    return { command: direction.command, duration };
}

async function executeRobotCommand(command, duration = 0) {
    if (!ESP32_IP) {
        const error = new Error("ESP32_IP не указан в .env.");
        error.status = 503;
        throw error;
    }

    let baseUrl;
    try {
        baseUrl = new URL(ESP32_IP);
        if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error();
    } catch {
        const error = new Error("ESP32_IP имеет неверный формат.");
        error.status = 500;
        throw error;
    }

    if (robotStopTimer) {
        clearTimeout(robotStopTimer);
        robotStopTimer = null;
    }

    const url = new URL(command, `${baseUrl.toString().replace(/\/$/, "")}/`).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`ESP32 ответил: ${response.status}`);
    const esp32 = await response.text();

    if (command !== "stop" && duration > 0) {
        robotStopTimer = setTimeout(async () => {
            try {
                const stopUrl = new URL("stop", `${baseUrl.toString().replace(/\/$/, "")}/`).toString();
                await fetch(stopUrl, { signal: AbortSignal.timeout(5000) });
            } catch (error) {
                console.error("Не удалось автоматически остановить ESP32:", error.message);
            } finally {
                robotStopTimer = null;
            }
        }, duration * 1000);
    }

    return {
        success: true,
        command,
        duration,
        esp32,
        message: command === "stop"
            ? "Робот остановлен. ⏹️"
            : duration > 0
                ? `Робот едет ${duration} сек. и остановится автоматически. 🤖`
                : "Команда роботу отправлена. 🤖"
    };
}