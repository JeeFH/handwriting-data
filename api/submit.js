/**
 * Vercel Serverless Function - 接收手写数据提交到 GitHub Issues
 * 接收 JSON：{ prompt: string, imageBase64: string }
 * 环境变量（Vercel 后台设置）：
 *   GITHUB_TOKEN  - GitHub Personal Access Token（repo 权限）
 *   GITHUB_REPO   - 格式：username/repo-name
 *   GITHUB_USER   - GitHub 用户名
 */

export const config = {
  api: {
    bodyParser: { sizeLimit: '3mb' },
  },
};

// 简单的内存速率限制（Vercel 无状态，短期同实例复用有效）
const ipLimitMap = new Map(); // ip -> { count, resetAt }
const MAX_PER_HOUR = 10;
const WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipLimitMap.get(ip);
  if (!record || now > record.resetAt) {
    ipLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_PER_HOUR - 1 };
  }
  if (record.count >= MAX_PER_HOUR) {
    return { allowed: false, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }
  record.count++;
  return { allowed: true, remaining: MAX_PER_HOUR - record.count };
}

function validateImage(base64Str) {
  if (typeof base64Str !== 'string') return { ok: false, reason: '格式错误' };
  if (!base64Str.startsWith('data:image/png;base64,')) {
    return { ok: false, reason: '仅支持 PNG 格式' };
  }
  const data = base64Str.replace(/^data:image\/\w+;base64,/, '');
  const sizeBytes = Buffer.from(data, 'base64').length;
  // 手写图正常范围：20KB ~ 1.5MB
  if (sizeBytes < 1 * 1024) return { ok: false, reason: '图片太小，可能为空白' };
  if (sizeBytes > 2 * 1024 * 1024) return { ok: false, reason: '图片超过 2MB' };
  return { ok: true, sizeBytes };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '只支持 POST' });

  try {
    const { prompt, imageBase64, strokeCount = 0, writeDuration = 0 } = req.body;

    if (!prompt || !imageBase64) {
      return res.status(400).json({ error: '缺少 prompt 或 imageBase64' });
    }

    // 1. 图片格式与大小校验
    const imgCheck = validateImage(imageBase64);
    if (!imgCheck.ok) {
      return res.status(400).json({ error: imgCheck.reason });
      const imgCheck = validateImage(imageBase64);
    if (!imgCheck.ok) {
      console.log('图片校验失败:', imgCheck.reason, '大小:', imgCheck.sizeBytes); // 加这行
      return res.status(400).json({ error: imgCheck.reason });
    }
    }

    // 2. 行为校验（笔画数、书写时长）——可被绕过，但增加脚本攻击成本
    // 注：测试阶段放宽限制
    console.log('校验数据:', { strokeCount, writeDuration, prompt }); // 加这行
    if (strokeCount < 1) {
      return res.status(400).json({ error: '笔画太少，请完整手写表达式' });
    }
    if (writeDuration < 200) {
      return res.status(400).json({ error: '书写太快，请认真手写' });
    }


    // 3. 速率限制（基于 X-Forwarded-For 或 socket IP）
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const rate = checkRateLimit(clientIp);
    if (!rate.allowed) {
      return res.status(429).json({ error: `提交太频繁，请 ${Math.ceil(rate.retryAfter / 60)} 分钟后再试` });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_REPO;
    const githubUser = process.env.GITHUB_USER;

    if (!githubToken || !githubRepo || !githubUser) {
      console.error('缺少环境变量');
      return res.status(500).json({ error: '服务器配置错误' });
    }

    // 生成随机 ID
    const randomId = Math.random().toString(36).substring(2, 10);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 解码 Base64 图片数据（去掉 data:image/png;base64, 前缀）
    const pngBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const rawPngUrl = `https://raw.githubusercontent.com/${githubRepo}/main/pending/handwriting-${randomId}.png`;

    // 1. 创建 GitHub Issue（pending-review 标签，嵌入图片预览）
    const issueRes = await fetch(`https://api.github.com/repos/${githubRepo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
        'User-Agent': githubUser,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        title: `[待审] ${prompt} - ${timestamp}`,
        body: `## 手写预览\n![手写图](${rawPngUrl})\n\n` +
              `## 表达式\n${prompt}\n\n` +
              `## 提交时间\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n` +
              `## 行为数据\n- 笔画数：${strokeCount}\n- 书写时长：${writeDuration}ms\n\n` +
              `## 数据文件\n- 图片：\`pending/handwriting-${randomId}.png\`\n- 元数据：\`pending/handwriting-${randomId}.json\``,
        labels: ['handwriting', 'pending-review'],
      }),
    });

    if (!issueRes.ok) {
      const errText = await issueRes.text();
      console.error('GitHub Issue 创建失败：', errText);
      return res.status(500).json({ error: '提交失败，请重试' });
    }

    const issueData = await issueRes.json();
    console.log(`Issue 创建成功：#${issueData.number}`);

    // 2. 把图片存为 PNG 文件（可直接预览）
    const pngRes = await fetch(
      `https://api.github.com/repos/${githubRepo}/contents/pending/handwriting-${randomId}.png`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${githubToken}`,
          'User-Agent': githubUser,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Add handwriting image for issue #${issueData.number}`,
          content: pngBase64,
          branch: 'main',
        }),
      }
    );

    if (!pngRes.ok) {
      const pngErr = await pngRes.text();
      console.warn('PNG 文件保存失败：', pngErr);
    }

    // 3. 同时保存 JSON 元数据（训练时使用）
    const metaPath = `pending/handwriting-${randomId}.json`;
    const metaContent = JSON.stringify({
      prompt: prompt,
      timestamp: new Date().toISOString(),
      strokeCount: strokeCount,
      writeDuration: writeDuration,
      imageFile: `handwriting-${randomId}.png`,
    }, null, 2);

    const metaRes = await fetch(
      `https://api.github.com/repos/${githubRepo}/contents/${metaPath}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${githubToken}`,
          'User-Agent': githubUser,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Add metadata for issue #${issueData.number}`,
          content: Buffer.from(metaContent).toString('base64'),
          branch: 'main',
        }),
      }
    );

    if (!metaRes.ok) {
      const metaErr = await metaRes.text();
      console.warn('元数据保存失败：', metaErr);
    }

    return res.status(200).json({
      success: true,
      issueNumber: issueData.number,
      issueUrl: issueData.html_url,
      message: '提交成功，等待审核后进入数据集',
    });

  } catch (err) {
    console.error('提交过程错误：', err);
    return res.status(500).json({ error: '服务器错误，请稍后重试' });
  }
}
