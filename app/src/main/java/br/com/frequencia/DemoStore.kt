package br.com.frequencia

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

internal class DemoStore(context: Context) : SQLiteOpenHelper(context, "demonstracao.db", null, 1) {
    private val prefs = context.getSharedPreferences("demo-profile", Context.MODE_PRIVATE)
    private val names = mapOf("arthur" to "Arthur", "rabelo" to "Rabelo", "leticia" to "Letícia", "erick" to "Erick")
    private val colors = mapOf("arthur" to "amber", "rabelo" to "ice", "leticia" to "lilac", "erick" to "lime")
    private val server = JSONObject("""{"id":"crias","name":"Os Crias","role":"owner","channels":[
        {"id":"geral","name":"geral","kind":"text"},{"id":"clipes","name":"clipes","kind":"text"},
        {"id":"memes","name":"memes","kind":"text"},{"id":"noite","name":"Call da noite","kind":"voice"},
        {"id":"afk","name":"AFK","kind":"voice"}]}""")

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, user TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0)")
        db.execSQL("CREATE TABLE reactions (message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, emoji TEXT NOT NULL, PRIMARY KEY(message, emoji))")
        val now = System.currentTimeMillis()
        listOf(
            Triple("geral", "arthur", "Quem vai jogar hoje?"),
            Triple("geral", "erick", "Tô na call. Bora uma partida?"),
            Triple("geral", "rabelo", "Já tô entrando."),
            Triple("geral", "leticia", "Fechou! Qual mapa hoje?"),
            Triple("geral", "arthur", "Bora de Dust 2 então."),
            Triple("clipes", "rabelo", "Esse é o canal pra mandar os melhores momentos."),
            Triple("memes", "arthur", "Espaço oficial pra mandar 💀")
        ).forEachIndexed { index, (channel, user, message) ->
            db.insertOrThrow("messages", null, values(channel, user, message, now - (12 - index) * 60_000))
        }
    }

    override fun onConfigure(db: SQLiteDatabase) = db.setForeignKeyConstraintsEnabled(true)

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    private fun values(channel: String, user: String, body: String, time: Long) = ContentValues().apply {
        put("channel", channel)
        put("user", user)
        put("body", body)
        put("created", time)
    }

    private fun person(user: String): JSONObject = JSONObject()
        .put("id", user)
        .put("name", if (user == "erick") prefs.getString("name", "Erick") else names[user])
        .put("handle", user)
        .put("accent", if (user == "erick") prefs.getString("accent", "lime") else colors[user])

    fun request(method: String, path: String, data: JSONObject): JSONObject {
        val uri = Uri.parse(path)
        val parts = uri.pathSegments
        if (path == "/api/state" && method == "GET") {
            val peers = names.keys.filter { it != "erick" }.map { person(it).put("status", "accepted") }
            return JSONObject().put("me", person("erick").put("bio", prefs.getString("bio", "")))
                .put("servers", JSONArray().put(server)).put("friends", JSONArray(peers)).put("media", false)
        }
        if (path == "/api/me" && method == "PATCH") {
            val name = data.optString("name").trim().take(32)
            if (name.isEmpty()) throw AppError(400, "Preencha o nome.")
            prefs.edit().putString("name", name).putString("bio", data.optString("bio").take(160))
                .putString("accent", data.optString("accent", "lime")).apply()
            return person("erick")
        }
        if (path == "/api/servers/crias/members" && method == "GET") {
            return JSONObject().put("items", JSONArray(names.keys.map {
                person(it).put("role", if (it == "erick") "owner" else "member")
            }))
        }
        if (parts.size >= 4 && parts[1] == "channels" && parts[2] in setOf("geral", "clipes", "memes") && parts[3] == "messages") {
            val channel = parts[2]
            val db = writableDatabase
            val id = parts.getOrNull(4)?.toLongOrNull()
            if (method == "GET" && id == null) return list(db, channel, uri)
            val operation = parts.getOrNull(5)
            if (method == "POST" && id == null) {
                db.insertOrThrow("messages", null, values(channel, "erick", messageBody(data), System.currentTimeMillis()))
            } else if (id != null) {
                val where = arrayOf(channel, id.toString())
                val author = db.rawQuery("SELECT user FROM messages WHERE channel=? AND id=?", where).use {
                    if (it.moveToFirst()) it.getString(0) else throw AppError(404, "Mensagem indisponível.")
                }
                when {
                    method == "DELETE" && operation == null -> db.delete("messages", "channel=? AND id=?", where)
                    method == "PATCH" && operation == null && author == "erick" ->
                        db.execSQL("UPDATE messages SET body=?, edited=1 WHERE channel=? AND id=?", arrayOf(messageBody(data), channel, id))
                    method == "POST" && operation == "pin" ->
                        db.execSQL("UPDATE messages SET pinned=? WHERE channel=? AND id=?", arrayOf(if (data.optBoolean("pinned")) 1 else 0, channel, id))
                    method == "POST" && operation == "reaction" -> {
                        val emoji = data.getString("emoji").take(16)
                        val deleted = db.delete("reactions", "message=? AND emoji=?", arrayOf(id.toString(), emoji))
                        if (deleted == 0) db.execSQL("INSERT INTO reactions VALUES (?,?)", arrayOf(id, emoji))
                    }
                    else -> throw AppError(403, "Ação indisponível.")
                }
            } else throw AppError(400, "Pedido inválido.")
            return JSONObject()
        }
        throw AppError(403, "Conecte um servidor para usar este recurso.")
    }

    private fun messageBody(data: JSONObject): String {
        val value = data.optString("body").trim()
        if (value.isEmpty() || value.length > 4000) throw AppError(400, "Use até 4.000 caracteres.")
        return value
    }

    private fun list(db: SQLiteDatabase, channel: String, uri: Uri): JSONObject {
        val before = uri.getQueryParameter("before")?.toLongOrNull() ?: Long.MAX_VALUE
        val query = uri.getQueryParameter("q").orEmpty().take(120)
        val pins = if (uri.getQueryParameter("pins") == "1") "1" else "0"
        val rows = mutableListOf<JSONObject>()
        db.rawQuery(
            "SELECT id,user,body,created,edited,pinned FROM messages WHERE channel=? AND id<? AND instr(lower(body),lower(?))>0 AND (?='0' OR pinned=1) ORDER BY id DESC LIMIT 41",
            arrayOf(channel, before.toString(), query, pins)
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val user = cursor.getString(1)
                val reactions = JSONArray()
                db.rawQuery("SELECT emoji FROM reactions WHERE message=? ORDER BY emoji", arrayOf(id.toString())).use {
                    while (it.moveToNext()) reactions.put(JSONObject().put("emoji", it.getString(0)).put("mine", 1).put("count", 1))
                }
                rows += person(user).put("id", id).put("user_id", user).put("body", cursor.getString(2))
                    .put("created_at", cursor.getLong(3)).put("edited", cursor.getInt(4))
                    .put("pinned", cursor.getInt(5)).put("reactions", reactions)
            }
        }
        return JSONObject().put("items", JSONArray(rows.take(40).reversed())).put("more", rows.size > 40)
    }
}
