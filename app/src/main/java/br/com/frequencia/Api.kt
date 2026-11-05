package br.com.frequencia

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.Buffer
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

internal class AppError(val status: Int, message: String) : Exception(message)

internal class Api(private val context: Context) {
    companion object {
        private const val MiB = 1024L * 1024
        private val emptyBody = ByteArray(0).toRequestBody(null)
        private val jsonType = "application/json; charset=utf-8".toMediaType()
        private val bytesType = "application/octet-stream".toMediaType()
        private val filePath = Regex("/api/files/[a-f0-9-]{36}")
        private val apiPath = Regex("/api/[A-Za-z0-9/_-]+(?:\\?[^#\\r\\n]*)?")
        private val imageTypes = setOf("image/jpeg", "image/png", "image/webp", "image/gif")
        private val ipPattern = Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}")

        private fun localHost(host: String): Boolean {
            if (host == "localhost" || host == "::1" || host == "[::1]") return true
            if (!ipPattern.matches(host)) return false
            val ip = host.split('.').map(String::toInt)
            if (ip.any { it > 255 }) return false
            return ip[0] == 10 || ip[0] == 127 || ip[0] == 192 && ip[1] == 168 ||
                ip[0] == 172 && ip[1] in 16..31
        }

        fun validatedOrigin(input: String, call: Boolean = false): String {
            val value = input.trim().trimEnd('/')
            val parsed = runCatching { URI(value) }.getOrNull()
            val host = parsed?.host ?: throw AppError(400, "Confira o endereço do servidor.")
            val secure = if (call) "wss" else "https"
            val local = if (call) "ws" else "http"
            if ((parsed.scheme != secure && (parsed.scheme != local || !localHost(host))) ||
                parsed.userInfo != null || !parsed.rawPath.isNullOrEmpty() ||
                parsed.rawQuery != null || parsed.rawFragment != null ||
                parsed.port == 0 || parsed.port > 65535) {
                throw AppError(400, "Use um endereço HTTPS. HTTP só funciona com IP de rede local.")
            }
            return value
        }
    }

    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .followRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(18, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .callTimeout(170, TimeUnit.SECONDS)
        .build()

    data class Connection(val mode: String, val base: String, val token: String)

    fun connection() = Connection(
        prefs.getString("mode", "start").orEmpty(),
        prefs.getString("base", "").orEmpty(),
        prefs.getString("token", "").orEmpty()
    )

    fun bootstrap(): JSONObject = connection().let {
        JSONObject().put("mode", it.mode).put("base", it.base).put("authenticated", it.token.isNotEmpty())
    }

    fun demo(): JSONObject {
        prefs.edit().putString("mode", "demo").remove("token").apply()
        return bootstrap()
    }

    fun configure(value: String): JSONObject {
        val origin = validatedOrigin(value)
        val info = request("GET", "/api/health", connection = Connection("online", origin, ""))
        if (info.optString("app") != "frequencia" || info.optInt("version") != 1) {
            throw AppError(400, "O endereço precisa apontar para um servidor Frequência compatível.")
        }
        val edit = prefs.edit().putString("mode", "online").putString("base", origin)
        if (connection().base != origin) edit.remove("token")
        edit.apply()
        return bootstrap()
    }

    fun login(register: Boolean, body: JSONObject): JSONObject {
        val connection = connection()
        val info = request("POST", if (register) "/api/register" else "/api/login", body, connection)
        val token = info.optString("token")
        if (!Regex("[A-Za-z0-9_-]{43}").matches(token)) throw AppError(502, "Resposta de login inválida.")
        if (connection() != connection) throw AppError(409, "A conexão foi alterada. Entre novamente.")
        prefs.edit().putString("token", token).apply()
        return bootstrap()
    }

    fun logout(): JSONObject {
        val current = connection()
        if (current.token.isNotEmpty()) runCatching { request("POST", "/api/logout", connection = current) }
        if (connection() == current) prefs.edit().remove("token").apply()
        return bootstrap()
    }

    private fun call(method: String, path: String, payload: RequestBody?, session: Connection): Response {
        if (session.base.isBlank() || !apiPath.matches(path) || method !in setOf("GET", "POST", "PATCH", "DELETE")) {
            throw AppError(400, "Pedido inválido.")
        }
        val url = (session.base + path).toHttpUrlOrNull()
            ?: throw AppError(400, "Endereço inválido.")
        val request = Request.Builder().url(url).header("Accept", "application/json")
        if (session.token.isNotBlank()) request.header("Authorization", "Bearer " + session.token)
        request.method(method, if (method == "POST" || method == "PATCH") payload ?: emptyBody else null)
        val response = http.newCall(request.build()).execute()
        if (!response.isSuccessful) {
            response.use {
                val message = runCatching { JSONObject(it.peekBody(4096).string()).getString("error") }.getOrNull()
                if (it.code == 401 && session.token.isNotEmpty() && connection() == session) {
                    prefs.edit().remove("token").apply()
                }
                throw AppError(it.code, message ?: "O servidor respondeu com erro " + it.code + ".")
            }
        }
        return response
    }

    fun request(method: String, path: String, data: JSONObject? = null, connection: Connection = connection()): JSONObject {
        return call(method, path, data?.toString()?.toRequestBody(jsonType), connection).use {
            val source = it.body?.source() ?: throw AppError(502, "Resposta vazia.")
            if (source.request(4 * MiB + 1)) throw AppError(502, "Resposta muito grande.")
            JSONObject(source.readUtf8())
        }
    }

    fun upload(path: String, uri: Uri, session: Connection): JSONObject {
        val isPhoto = path == "/api/me/avatar" || path == "/api/me/banner"
        val max = (if (isPhoto) 2 else 100) * MiB
        val resolver = context.contentResolver
        var name = "arquivo"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) {
                name = (it.getString(0) ?: name).take(140)
                if (!it.isNull(1)) size = it.getLong(1)
            }
        }
        if (size > max) throw AppError(413, if (isPhoto) "A imagem pode ter até 2 MiB." else "O anexo pode ter até 100 MiB.")
        val uploadPath = if (isPhoto) path else path + "?name=" + Uri.encode(name)
        val payload = object : RequestBody() {
            override fun contentType() = bytesType
            override fun contentLength() = size
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                resolver.openInputStream(uri)?.source()?.use { source ->
                    val buffer = Buffer()
                    var written = 0L
                    while (true) {
                        val count = source.read(buffer, 32 * 1024)
                        if (count < 0) break
                        written += count
                        if (written > max) throw IOException("Arquivo grande demais.")
                        sink.write(buffer, count)
                    }
                } ?: throw IOException("O arquivo não está disponível.")
            }
        }
        return call("POST", uploadPath, payload, session).use {
            JSONObject(it.peekBody(64 * 1024).string())
        }
    }

    fun image(id: String, session: Connection): JSONObject {
        val path = "/api/files/$id"
        if (!filePath.matches(path)) throw AppError(400, "Imagem inválida.")
        return call("GET", path, null, session).use {
            val type = it.header("Content-Type")
            val source = it.body?.source()
            if (type !in imageTypes || source == null || source.request(2 * MiB + 1)) {
                throw AppError(400, "Imagem indisponível.")
            }
            val bytes = source.readByteArray()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth !in 1..2048 || bounds.outHeight !in 1..2048) {
                throw AppError(400, "A imagem pode ter até 2048 × 2048 pixels.")
            }
            JSONObject().put("data", "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
    }

    fun save(id: String, uri: Uri, session: Connection) {
        val path = "/api/files/$id"
        if (!filePath.matches(path)) throw AppError(400, "Arquivo inválido.")
        call("GET", path, null, session).use { response ->
            val body = response.body ?: throw AppError(502, "Arquivo indisponível.")
            val length = body.contentLength()
            if (length !in 1..100 * MiB) throw AppError(502, "Tamanho de arquivo inválido.")
            context.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                val input = body.byteStream()
                val buffer = ByteArray(32 * 1024)
                var remaining = length
                while (remaining > 0) {
                    val count = input.read(buffer, 0, minOf(remaining, buffer.size.toLong()).toInt())
                    if (count < 0) throw IOException("Download incompleto.")
                    out.write(buffer, 0, count)
                    remaining -= count
                }
            } ?: throw IOException("O destino não está disponível.")
        }
    }
}
