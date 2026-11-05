package br.com.frequencia

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var api: Api
    private lateinit var demo: DemoStore
    private lateinit var voice: VoicePanel
    private data class FileAction(val requestId: String, val target: String, val session: Api.Connection, val upload: Boolean)
    private var pendingFile: FileAction? = null
    private val chooseFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val action = pendingFile ?: return@registerForActivityResult
        pendingFile = null
        val uri = result.data?.data
        if (result.resultCode != RESULT_OK || uri == null || uri.scheme != "content") {
            reply(action.requestId, JSONObject().put("cancelled", true))
            return@registerForActivityResult
        }
        lifecycleScope.launch {
            try {
                val transfer = withContext(Dispatchers.IO) {
                    try {
                        if (api.connection() != action.session) throw AppError(409, "Sua sessão mudou.")
                        if (action.upload) api.upload(action.target, uri, action.session)
                        else {
                            api.save(action.target, uri, action.session)
                            JSONObject()
                        }
                    } catch (error: Exception) {
                        if (!action.upload) runCatching { DocumentsContract.deleteDocument(contentResolver, uri) }
                        throw error
                    }
                }
                reply(action.requestId, transfer)
            } catch (error: Exception) { reject(action.requestId, error) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = Api(this)
        demo = DemoStore(this)
        val root = FrameLayout(this)
        web = WebView(this)
        web.setBackgroundColor(Color.rgb(23, 24, 25))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                val resource = url.lastPathSegment
                val type = when (resource) {
                    "index.html" -> "text/html"
                    "style.css" -> "text/css"
                    "app.js" -> "text/javascript"
                    else -> null
                }
                if (url.scheme == "https" && url.host == "appassets.androidplatform.net" &&
                    url.path == "/ui/$resource" && type != null) {
                    return WebResourceResponse(type, "UTF-8", assets.open("ui/$resource"))
                }
                return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }
        web.addJavascriptInterface(Bridge(), "FrequenciaAndroid")
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        voice = VoicePanel(this, root, api) { state -> dispatch("call", state) }
        setContentView(root)
        web.loadUrl("https://appassets.androidplatform.net/ui/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (voice.visible) voice.minimize() else dispatch("back", JSONObject())
            }
        })
    }

    private inner class Bridge {
        @JavascriptInterface
        fun post(raw: String) {
            if (raw.length > 32_768) return
            val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
            val id = message.optString("id")
            if (!id.matches(Regex("[0-9]{1,12}"))) return
            lifecycleScope.launch {
                try {
                    val action = message.optString("action")
                    val args = message.optJSONObject("args") ?: JSONObject()
                    val result = when (action) {
                        "bootstrap" -> api.bootstrap()
                        "demo" -> {
                            voice.leave()
                            withContext(Dispatchers.IO) { api.demo() }
                        }
                        "configure" -> {
                            voice.leave()
                            withContext(Dispatchers.IO) { api.configure(args.getString("address")) }
                        }
                        "login" -> withContext(Dispatchers.IO) { api.login(args.optBoolean("register"), args.getJSONObject("data")) }
                        "logout" -> {
                            voice.leave()
                            withContext(Dispatchers.IO) { api.logout() }
                        }
                        "request" -> withContext(Dispatchers.IO) {
                            val session = api.connection()
                            val method = args.getString("method")
                            val path = args.getString("path")
                            val body = args.optJSONObject("data") ?: JSONObject()
                            if (session.mode == "demo") demo.request(method, path, body)
                            else api.request(method, path, body, session)
                        }
                        "image" -> withContext(Dispatchers.IO) { api.image(args.getString("file"), api.connection()) }
                        "upload", "download" -> {
                            pickFile(id, action == "upload", args)
                            return@launch
                        }
                        "copy" -> {
                            val clipboard = getSystemService(android.content.ClipboardManager::class.java)
                            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Frequência", args.getString("value").take(4000)))
                            JSONObject()
                        }
                        "joinCall" -> {
                            voice.join(args.getString("channel"), args.getString("label").take(40), args.optBoolean("hd"))
                            JSONObject()
                        }
                        "showCall" -> {
                            voice.show()
                            JSONObject()
                        }
                        else -> throw AppError(400, "Ação inválida.")
                    }
                    reply(id, result)
                } catch (error: Exception) { reject(id, error) }
            }
        }
    }

    private fun pickFile(id: String, upload: Boolean, args: JSONObject) {
        if (pendingFile != null) throw AppError(409, "Já existe uma seleção aberta.")
        val current = api.connection()
        if (current.mode != "online" || current.token.isEmpty()) throw AppError(403, "Entre na sua conta para transferir arquivos.")
        val target = args.getString("target")
        val photo = target in setOf("/api/me/avatar", "/api/me/banner")
        val uuid = "[a-f0-9-]{36}"
        if ((upload && !photo && !Regex("/api/channels/$uuid/files").matches(target)) ||
            (!upload && !Regex(uuid).matches(target))) throw AppError(400, "Arquivo inválido.")
        val intent = Intent(if (upload) Intent.ACTION_OPEN_DOCUMENT else Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = when {
                photo -> "image/*"
                upload -> "*/*"
                else -> "application/octet-stream"
            }
            if (!upload) putExtra(Intent.EXTRA_TITLE, args.optString("name", "arquivo").take(140))
        }
        pendingFile = FileAction(id, target, current, upload)
        try { chooseFile.launch(intent) } catch (error: Exception) {
            pendingFile = null
            throw AppError(400, "O seletor de arquivos não está disponível neste aparelho.")
        }
    }

    private fun dispatch(event: String, data: JSONObject) {
        web.evaluateJavascript("window.frequenciaEvent?.(" + JSONObject.quote(event) + "," + JSONObject.quote(data.toString()) + ")", null)
    }

    private fun reply(id: String, result: JSONObject) {
        dispatch("reply", JSONObject().put("id", id).put("data", result))
    }

    private fun reject(id: String, error: Exception) {
        if (error is CancellationException) throw error
        val message = when (error) {
            is AppError -> error.message
            is IOException -> "Não foi possível concluir. Confira a conexão e tente novamente."
            else -> "Não foi possível concluir esta ação."
        }
        dispatch("reply", JSONObject().put("id", id).put("error", message).put("status", (error as? AppError)?.status ?: 0))
    }

    override fun onDestroy() {
        voice.destroy()
        web.removeJavascriptInterface("FrequenciaAndroid")
        web.destroy()
        super.onDestroy()
    }
}
