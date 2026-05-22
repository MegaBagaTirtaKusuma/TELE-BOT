require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);
const ffprobePath = require("ffprobe-static").path;
ffmpeg.setFfprobePath(ffprobePath);
const path = require("path");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
});

console.log("BOT RUNNING!");

const sessions = {};

// Auto hapus file temp lebih dari 1 jam
setInterval(() => {
  const now = Date.now();
  const files = fs.readdirSync(__dirname);
  files.forEach(file => {
    if (
      file.startsWith("ref_") ||
      file.startsWith("seg_") ||
      file.startsWith("combined_") ||
      file.startsWith("output_")
    ) {
      const filePath = path.join(__dirname, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        console.log("AUTO DELETE:", file);
      }
    }
  });
}, 60 * 60 * 1000); // cek setiap 1 jam

// ==========================
// LOADING ANIMATION
// ==========================

async function startLoading(chatId) {
  const progressMessage = await bot.sendMessage(
    chatId,
    `⏳ Sedang memproses AI...

⬜⬜⬜⬜⬜
⏱ 0 detik`
  );

  const frames = [
    "🟩⬜⬜⬜⬜",
    "⬜🟩⬜⬜⬜",
    "⬜⬜🟩⬜⬜",
    "⬜⬜⬜🟩⬜",
    "⬜⬜⬜⬜🟩",
    "⬜⬜⬜🟩⬜",
    "⬜⬜🟩⬜⬜",
    "⬜🟩⬜⬜⬜",
  ];

  let index = 0;
  let seconds = 0;

const interval = setInterval(async () => {
    seconds++;
    index = (index + 1) % frames.length;
    sessions[chatId].seconds = seconds;

    try {
      await bot.editMessageText(
        `⏳ Sedang memproses AI...

${frames[index]}
⏱ ${seconds} detik`,
        {
          chat_id: chatId,
          message_id: progressMessage.message_id,
        }
      );
    } catch (e) {}
  }, 1000);

  return { progressMessage, interval };
}


// ==========================
// GENERATE MOTION AI
// ==========================

async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

async function generateMotionAI(imageUrl, motionVideoUrl, ratio, duration) {
  let API_KEY = process.env.MAGNIFIC_API_KEY;
try {
  const config = JSON.parse(fs.readFileSync("/tmp/config.json"));
  if (config.magnific_api_key) API_KEY = config.magnific_api_key;
} catch (e) {}

  const response = await axios.post(
    "https://api.magnific.com/v1/ai/image-to-video/kling-v2",
    {
  image: imageUrl,
  motion_video: motionVideoUrl,
  ratio: ratio,
  duration: duration,
  cfg_scale: 0.9,
  prompt: "STRICT MOTION REFERENCE MODE. Follow the reference video motion exactly. Copy the original movement sequence precisely. Maintain: exact body movement, exact pose transitions, exact hand movement, exact head movement, exact walking rhythm, exact timing, exact speed, exact choreography, exact motion trajectory. Frame-by-frame motion consistency. High motion adherence. High temporal consistency. Preserve original motion dynamics. Do not generate new actions. Do not add cinematic motion. Do not change pacing. Do not alter choreography. Do not improvise movement. The generated video must feel like the same motion performance from the reference video. Ultra realistic. Natural human motion.",
},
    {
      headers: {
        "x-magnific-api-key": API_KEY,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

async function pollUntilDone(taskId, apiKey) {
  let videoUrl = null;
  while (!videoUrl) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.get(
      `https://api.magnific.com/v1/ai/image-to-video/kling-v2/${taskId}`,
      { headers: { "x-magnific-api-key": apiKey } }
    );
    // console.log("STATUS POLL:", JSON.stringify(statusRes.data, null, 2));
    if (statusRes.data?.data?.status === "COMPLETED") {
      videoUrl = statusRes.data?.data?.generated?.[0];
    }
  }
  return videoUrl;
}

// ==========================
// START MENU
// ==========================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `🎭 MotionThing AI

Pilih fitur di bawah ini`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎬 Motion Control",
              callback_data: "motion_control",
            },
          ],
          [
            {
              text: "🖼 Image Generate",
              callback_data: "image_generate",
            },
          ],
          [
            {
              text: "🔑 Update API Key",
              callback_data: "update_api_key",
            },
          ],
        ],
      },
    }
  );
});

// ==========================
// PHOTO HANDLER
// ==========================
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  if (!sessions[chatId]) return;

  // ==========================
  // MOTION CONTROL PHOTO
  // ==========================
  if (sessions[chatId].step === "WAITING_PHOTO") {
    const photo = msg.photo[msg.photo.length - 1];
    sessions[chatId].photo = photo.file_id;
    sessions[chatId].step = "WAITING_RATIO";

    return bot.sendMessage(chatId, "📐 Pilih ukuran video:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "9:16", callback_data: "ratio_9_16" },
            { text: "16:9", callback_data: "ratio_16_9" },
          ],
        ],
      },
    });
  }

  // ==========================
  // IMAGE GENERATE PHOTO
  // ==========================
  if (sessions[chatId].step === "WAITING_REF_PHOTO") {
  const photo = msg.photo[msg.photo.length - 1];
  const fileLink = await bot.getFileLink(photo.file_id);

  await bot.sendMessage(chatId, "⏳ Menganalisis foto...");

  try {
    const imgRes = await axios.get(fileLink, { responseType: "arraybuffer" });
    const base64Image = Buffer.from(imgRes.data).toString("base64");

    const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent([
      { inlineData: { mimeType: "image/jpeg", data: base64Image } },
      { text: "Describe this person in extreme detail for image generation: face shape, eye color, nose, lips, skin tone, hair color, hair style, hair length, body type, outfit, accessories. Be very specific and detailed." },
    ]);

    const description = result.response.text();
    sessions[chatId].refDescription = description;
    sessions[chatId].step = "WAITING_PROMPT";

    return bot.sendMessage(chatId, "✅ Foto dianalisis! Sekarang kirim prompt tambahan.\n\n(contoh: di pantai pakai gaun merah)");
  } catch (err) {
    console.log("ANALYZE ERROR:", err.message);
    bot.sendMessage(chatId, "❌ Gagal analisis foto.");
  }
}
});

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;

  if (!sessions[chatId]) return;

  if (
    sessions[chatId].step !==
    "WAITING_MOTION_VIDEO"
  ) {
    return;
  }

  const video = msg.video;

  sessions[chatId].motionVideo =
    video.file_id;

  sessions[chatId].step = "PROCESSING";

  await bot.sendMessage(
    chatId,
    `✅ Data lengkap!

📸 Foto: sudah ada
📐 Ratio: ${sessions[chatId].ratio}
🎥 Motion video: sudah ada`
  );

  const { progressMessage, interval } = await startLoading(chatId);

try {
  // ==========================
  // PHOTO URL
  // ==========================

  const photoUrl = await bot.getFileLink(
    sessions[chatId].photo
  );

  console.log("PHOTO:", photoUrl);

  // ==========================
  // AI GENERATE
  // ==========================

const motionVideoUrl = await bot.getFileLink(
  sessions[chatId].motionVideo
);
console.log("MOTION URL:", motionVideoUrl);
console.log("PHOTO URL:", photoUrl);

let API_KEY = process.env.MAGNIFIC_API_KEY;
try {
  const config = JSON.parse(fs.readFileSync("/tmp/config.json"));
  if (config.magnific_api_key) API_KEY = config.magnific_api_key;
} catch (e) {}

// Download referensi video dulu untuk cek durasi
const refVideoPath = path.join(__dirname, `ref_${chatId}.mp4`);
const refRes = await axios.get(motionVideoUrl, { 
  responseType: "stream",
  headers: {
    "Authorization": `Bot ${process.env.TELEGRAM_BOT_TOKEN}`
  }
});
await new Promise((resolve, reject) => {
  const writer = fs.createWriteStream(refVideoPath);
  refRes.data.pipe(writer);
  writer.on("finish", resolve);
  writer.on("error", reject);
});

const segments = ["10"];
console.log("SEGMENTS:", segments);

const segmentPaths = [];

for (let i = 0; i < segments.length; i++) {
  console.log(`GENERATING SEGMENT ${i + 1}/${segments.length}`);

  const result = await generateMotionAI(
    photoUrl,
    motionVideoUrl,
    sessions[chatId].ratio,
    segments[i]
  );

  const taskId = result.data.task_id;
  const videoUrl = await pollUntilDone(taskId, API_KEY);

  const segPath = path.join(__dirname, `seg_${chatId}_${i}.mp4`);
  const segRes = await axios.get(videoUrl, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(segPath);
    segRes.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  segmentPaths.push(segPath);
}

// Gabungkan semua segment
const combinedPath = path.join(__dirname, `combined_${chatId}.mp4`);
const outputPath = path.join(__dirname, `output_${chatId}.mp4`);

await new Promise((resolve, reject) => {
  const cmd = ffmpeg();
  segmentPaths.forEach(p => cmd.input(p));
  cmd
    .on("end", resolve)
    .on("error", reject)
    .mergeToFile(combinedPath, __dirname);
});

// Tambah audio dari referensi
await new Promise((resolve, reject) => {
  ffmpeg()
    .input(combinedPath)
    .input(refVideoPath)
    .outputOptions([
      "-map 0:v",
      "-map 1:a",
      "-c:v copy",
      "-c:a aac",
      "-shortest",
    ])
    .output(outputPath)
    .on("end", resolve)
    .on("error", reject)
    .run();
});

// Kirim ke Telegram
await bot.sendVideo(chatId, fs.createReadStream(outputPath), {
  caption: "🎬 Motion berhasil dibuat!",
});

// Hapus file temp
segmentPaths.forEach(p => fs.unlinkSync(p));
fs.unlinkSync(refVideoPath);
fs.unlinkSync(combinedPath);
fs.unlinkSync(outputPath);

// ← TARUH DI SINI
clearInterval(interval);
await bot.editMessageText(
  `✅ Selesai! 🎬

🟩🟩🟩🟩🟩
⏱ ${sessions[chatId].seconds} detik`,
  {
    chat_id: chatId,
    message_id: progressMessage.message_id,
  }
);

} catch (err) {
  console.log("ERROR MESSAGE:", err.message);
  console.log("ERROR CODE:", err.code);
  console.log("FULL DATA:", JSON.stringify(err.response?.data, null, 2));
  console.log("STATUS:", err.response?.status);

  clearInterval(interval);
  await bot.editMessageText(
    `❌ Gagal generate motion AI

⏱ ${sessions[chatId].seconds || 0} detik`,
    {
      chat_id: chatId,
      message_id: progressMessage.message_id,
    }
  );

  if (err.response?.status === 429) {
    bot.sendMessage(chatId, "⚠️ Limit API habis! Update API key dulu.", {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "🔑 Update API Key",
          callback_data: "update_api_key",
        },
      ],
    ],
  },
});
  } else {
    bot.sendMessage(chatId, "❌ Gagal generate motion AI");
  }
}
});

// ==========================
// CALLBACK BUTTON
// ==========================

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  // ==========================
  // MOTION CONTROL
  // ==========================

  if (query.data === "motion_control") {
    sessions[chatId] = {
      step: "WAITING_PHOTO",
    };

    return bot.editMessageText(
      "📸 Kirim foto karakter terlebih dahulu.",
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );
  }

  // ==========================
  // IMAGE GENERATE
  // ==========================

  if (query.data === "image_generate") {
  sessions[chatId] = {
    step: "WAITING_REF_PHOTO",
  };

  return bot.editMessageText(
    "📸 Kirim foto referensi karakter.",
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
}

  // ==========================
  // UPDATE API KEY
  // ==========================

  if (query.data === "update_api_key") {
    sessions[chatId] = {
      step: "WAITING_API_KEY",
    };

    return bot.editMessageText(
      "🔑 Kirim API key terbaru.",
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );
  }

  // ==========================
  // RATIO
  // ==========================

  if (!sessions[chatId]) return;

  if (query.data === "ratio_9_16") {
    sessions[chatId].ratio = "9:16";
  }

  if (query.data === "ratio_16_9") {
    sessions[chatId].ratio = "16:9";
  }

  sessions[chatId].step = "WAITING_MOTION_VIDEO";

  return bot.editMessageText(
    "🎥 Sekarang upload video gerakan referensi.",
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
});

// ==========================
// MESSAGE HANDLER
// ==========================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (!sessions[chatId]) return;

  // ==========================
  // IMAGE PROMPT
  // ==========================

if (sessions[chatId].step === "WAITING_PROMPT") {
  sessions[chatId].prompt = msg.text;
  sessions[chatId].step = null;

  await bot.sendMessage(chatId, "⏳ Generating image...");

  try {
    const fullPrompt = `${sessions[chatId].refDescription || ""}, ${msg.text}, highly detailed, realistic, high quality`;
const prompt = encodeURIComponent(fullPrompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=1024&height=1024&nologo=true`;

    await bot.sendPhoto(chatId, imageUrl, { caption: "🖼 Gambar berhasil dibuat!" });
  } catch (err) {
    console.log("IMAGE GEN ERROR:", err.message);
    bot.sendMessage(chatId, "❌ Gagal generate gambar.");
  }
}

  // ==========================
  // UPDATE API KEY
  // ==========================

if (sessions[chatId].step === "WAITING_API_KEY") {
  const apiKey = msg.text;

  process.env.MAGNIFIC_API_KEY = apiKey;
  fs.writeFileSync("/tmp/config.json", JSON.stringify({ magnific_api_key: apiKey }, null, 2));

  sessions[chatId].step = null;

  return bot.sendMessage(
    chatId,
    "✅ API key berhasil diupdate!"
  );
}
});
