let mytoken = '';

export default {
    async fetch(request, env) {
        try {
            mytoken = env.TOKEN || mytoken;

            if (!env.KV) {
                throw new Error('KV 命名空间未绑定');
            }

            const url = new URL(request.url);
            const token = url.searchParams.get('token');

            if (!mytoken || token !== mytoken) {
                return createResponse('token 有误', 403);
            }

            switch (url.pathname) {
                case "/config":
                case "/":
                    return createResponse(configHTML(url.hostname, token), 200, { 'Content-Type': 'text/html; charset=UTF-8' });
                case "/config/update.bat":
                    return createResponse(generateBatScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.bat', "Content-Type": "text/plain; charset=utf-8" });
                case "/config/update.sh":
                    return createResponse(generateShScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.sh', "Content-Type": "text/plain; charset=utf-8" });
                default:
                    let fileName = url.pathname.substring(1).toLowerCase(); // 将文件名转换为小写
                     
                    return await handleFileOperation(env.KV, fileName, url, request, token);
            }
        } catch (error) {
            console.error("Error:", error);
            return createResponse(`Error: ${error.message}`, 500);
        }
    }
};

/**
 * 处理文件操作
 * @param {Object} KV - KV 命名空间实例
 * @param {String} fileName - 文件名
 * @param {Object} request - request - The incoming request object
 * @param {String} token - 认证 token
 */
async function handleFileOperation(KV, fileName, url, request, token) {

    const text = url.searchParams.get('text') ?? null;
    const b64 = url.searchParams.get('b64') ?? null;
    const contentType = request.headers.get("content-type");

    // 如果没有传递数据过来，尝试从 KV 存储中获取文件内容
    if (text === null && b64 === null && !contentType?.includes("form")) {
        const value = await KV.get(fileName, { cacheTtl: 60 });
        if (value === null) {
            return createResponse('File not found', 404);
        }
        return createResponse(value);
    }

    let content = "";

    if (!contentType?.includes("form")) {
        try {
            // 从请求中获取表单数据
            const formData = await request.formData();
            const file = formData.get('file');

            if (file) {
                // 读取文件内容
                const arrayBuffer = await file.arrayBuffer();
                content = new TextDecoder().decode(arrayBuffer);
            } else {
                throw new Error('File not found in the request');
            }
        } catch (error) {
            throw new Error(`Error processing the request: ${error.message}`);
        }
    }
    // 如果传递了 text 或 b64 参数，将内容写入 KV 存储
    else {
        content = text ?? base64Decode(replaceSpacesWithPlus(b64));
    }

    await KV.put(fileName, content);
    const verifiedContent = await KV.get(fileName, { cacheTtl: 60 });

    if (verifiedContent !== content) {
        throw new Error('Content verification failed after write operation');
    }

    return createResponse(verifiedContent);
}

/**
 * 创建 HTTP 响应
 * @param {String} body - 响应内容
 * @param {Number} status - HTTP 状态码
 * @param {Object} additionalHeaders - 额外的响应头部信息
 */
function createResponse(body, status = 200, additionalHeaders = {}) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'ETag': Math.random().toString(36).substring(2, 15),
        'Last-Modified': new Date().toUTCString(),
        'cf-cache-status': 'DYNAMIC',
        ...additionalHeaders
    };
    return new Response(body, { status, headers });
}

/**
 * 解码 base64 字符串
 * @param {String} str - base64 字符串
 */
function base64Decode(str) {
    try {
        const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
        throw new Error('Invalid base64 string');
    }
}

/**
 * 将字符串中的空格替换为加号
 * @param {String} str - 输入字符串
 */
function replaceSpacesWithPlus(str) {
    return str.replace(/ /g, '+');
}

/**
 * 生成 Windows bat 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateBatScript(domain, token) {
    return [
        '@echo off',
        'chcp 65001',
        'setlocal',
        '',
        `set "DOMAIN=${domain}"`,
        `set "TOKEN=${token}"`,
        '',
        'rem %~nx1表示第一个参数的文件名和扩展名',
        'set "FILENAME=%~nx1"',
        '',
        'rem PowerShell命令读取整个文件内容并转换为Base64',
        'for /f "delims=" %%i in (\'powershell -command "$content = (Get-Content -Path \'%cd%/%FILENAME%\' -Encoding UTF8) -join [Environment]::NewLine; [convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))"\') do set "BASE64_TEXT=%%i"',
        '',
        'rem 构造GET请求URL (带有FILENAME和TOKEN参数)',
        'set "URL=https://%DOMAIN%/%FILENAME%?token=%TOKEN%"',
        '',
        'rem 构造POST数据 (文件内容的Base64编码)',
        'set "POST_DATA=b64=%BASE64_TEXT%"',
        '',
        'rem 使用curl发送POST请求，数据作为POST主体传递，并捕获错误输出',
        'curl --fail -X POST "%URL%" ^',
        '    -H "Content-Type: application/x-www-form-urlencoded" ^',
        '    -d "%POST_DATA%"',
        '',
        'rem 检查curl的返回码，如果失败，打印错误信息并不自动关闭',
        'if %errorlevel% neq 0 (',
        '    echo/',
        '    echo 连接失败，请检查域名和TOKEN是否正确!',
        '    pause',
        '    exit /b',
        ')',
        '',
        'rem 如果连接成功，显示成功消息并开始倒计时',
        'echo/',
        'echo/',
        'echo 数据已成功发送到服务器, 倒数5秒后自动关闭窗口...',
        'timeout /t 5 >nul',
        'exit'
    ].join('\r\n');
}

/**
 * 生成 Linux sh 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateShScript(domain, token) {
    return `#!/bin/bash

export LANG=zh_CN.UTF-8
# 设置域名和令牌
DOMAIN="${domain}"
TOKEN="${token}"

if [ -n "$1" ]; then 
  FILENAME="$1"
else
  echo "无文件名"
  exit 1
fi

# 读取整个文件内容并转换为 Base64 编码
BASE64_TEXT=$(base64 -w 0 "$FILENAME")

# 构造 POST 数据（文件内容的 Base64 编码）
POST_DATA="b64=$BASE64_TEXT"

# 构造 GET 请求的 URL，包含文件名和令牌参数
URL="https://$DOMAIN/$FILENAME?token=$TOKEN"

# 使用 curl 发送 POST 请求，数据作为 POST 主体传递，并捕获错误输出
RESPONSE=$(curl --fail -X POST "$URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "$POST_DATA" 2>&1)

# 检查 curl 的返回码，如果失败，打印错误信息并不自动关闭
if [[ $? -ne 0 ]]; then
    echo "连接失败，请检查域名和 TOKEN 是否正确。"
    echo "错误信息：$RESPONSE"
    exit 1
fi

# 如果连接成功，显示成功消息并开始倒计时
echo "数据已成功发送到服务器，倒数 5 秒后自动关闭窗口..."
sleep 5
exit 0
`;
}

/**
 * 生成 HTML 配置页面
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */

function configHTML(domain, token) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF-Workers-TEXT2KV 配置信息</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 15px; max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; }
        h2 { text-align: left; font-size:1.3rem}
        pre,code { padding: 0px; border-radius: 8px; overflow-x: auto; white-space: nowrap; }
        pre code { background: none; padding: 0; border: none; }
        button { 
        white-space: nowrap;
        cursor: pointer; 
        padding: 10px 10px; 
        margin-top: 0px; 
        border: none; 
        border-radius: 5px; 
    flex-shrink: 0; /* 防止按钮缩小 */
        }
        button:hover { opacity: 0.9; }
        input[type="text"] { 
            padding: 9px 10px;
            border-radius: 5px;
            flex-grow: 1;
            min-width:0;
        }
        .tips {
            color:grey;
            font-size:0.8em;
            border-left: 1px solid #666;
            padding-left: 10px;
        }
        .container { 
        padding: 5px 15px 15px 15px; 
        border-radius: 10px; 
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1); }
            /* Flexbox layout for h2 and button */
        .flex-row { 
        display: flex; 
        justify-content: space-between; 
        align-items: center; 
        margin-top:-10px !important;
        margin-bottom:-10px !important;
        }
        .download-button {
            padding: 5px 10px; /* 调整按钮的内边距，改变大小 */
            margin:0 !importan;
            background-color: Indigo !important; /* 设置按钮背景颜色 */
            color: white; /* 设置按钮文本颜色 */
            border: none; /* 去掉边框 */
            border-radius: 5px; /* 设置圆角 */
            cursor: pointer; /* 设置鼠标悬停时的光标样式 */
            transition: background-color 0.3s; /* 添加背景颜色的过渡效果 */
        }
        
        .download-button:hover {
            background-color: #45a049; /* 鼠标悬停时的背景颜色 */
        }
        .input-button-container {
            display: flex;
            align-items: center;
            gap: 5px;
        }

        /* Light theme */
        body.light { background-color: #f0f0f0; color: #333; }
        h1.light { color: #444; }
        pre.light { background-color: #fff; border: 1px solid #ddd; }
        button.light { background-color: DarkViolet; color: #fff; }
        input[type="text"].light { border: 1px solid #ddd; }
        .container.light { background-color: #fff; }

        /* Dark theme */
        body.dark { background-color: #1e1e1e; color: #c9d1d9; }
        h1.dark { color: #c9d1d9; }
        pre.dark { background-color: #2d2d2d; border: 1px solid #444; }
        button.dark { background-color: DarkViolet; color: #c9d1d9; }
        input[type="text"].dark { border: 1px solid #444; }
        .container.dark { background-color: #2d2d2d; }
    </style>
    <!-- 引入 Highlight.js 的 CSS 文件 -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/obsidian.min.css">
    <!-- 引入 Highlight.js 的 JavaScript 文件 -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
    <script>hljs.highlightAll();</script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            document.body.classList.add(theme);
            document.querySelectorAll('h1, pre, button, input[type="text"], .container').forEach(el => el.classList.add(theme));
        });
    </script>
</head>
<body>
        <h1>TEXT2KV 配置信息</h1>
    <div class="container">

        <p>
            <strong>服务域名:</strong> ${domain}<br>
            <strong>TOKEN:</strong> ${token}<br>
        </p>
        <p class="tips"><strong>注意!</strong> 请保管好自己的TOKEN，泄漏了域名和TOKEN他人可以直接获取你的数据。</p>
    <div class="flex-row">
    <h2>Windows 脚本:</h2>
    <button class="download-button" onclick="window.open('https://${domain}/config/update.bat?token=${token}&t=' + Date.now(), '_blank')">点击下载</button>
    </div>
        <pre><code>update.bat ip.txt</code></pre>
        <h2>Linux 脚本:</h2>
        <pre><code class="language-bash">curl "https://${domain}/config/update.sh?token=${token}&t=$(date +%s%N)" -o update.sh && chmod +x update.sh</code></pre>
        <h2>在线文档查询:</h2>
        <div class="input-button-container">
        <input type="text" id="keyword" placeholder="请输入要查询的文档">
        <button onclick="viewDocument()">查看文档内容</button>
        <button onclick="copyDocumentURL()">复制文档地址</button>
        </div>
    </div>
    <script>
        /**
         * 查看文档内容
         */
        function viewDocument() {
            const keyword = document.getElementById('keyword').value;
            window.open('https://${domain}/' + keyword + '?token=${token}&t=' + Date.now(), '_blank');
        }

        /**
         * 复制文档地址到剪贴板
         */
        function copyDocumentURL() {
            const keyword = document.getElementById('keyword').value;
            const url = 'https://${domain}/' + keyword + '?token=${token}&t=' + Date.now();
            navigator.clipboard.writeText(url).then(() => alert('文档地址已复制到剪贴板'));
        }
    </script>
</body>
</html>
    `;
}
