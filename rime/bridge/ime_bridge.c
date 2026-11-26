/*
 * 零黑框、亚毫秒级 Windows Rime Lua <-> 本地 AI 推理服务 TCP 桥接库
 * 编译: gcc -shared -O2 ime_bridge.c "C:\Program Files\Rime\weasel-0.17.4\rime.dll" -lws2_32 -o ime_bridge.dll
 */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdint.h>
#include <string.h>

typedef struct lua_State lua_State;
typedef int (*lua_CFunction)(lua_State *L);

extern void lua_createtable(lua_State *L, int narr, int nrec);
extern void lua_setfield(lua_State *L, int idx, const char *k);
extern void lua_pushcclosure(lua_State *L, lua_CFunction fn, int n);
extern const char *lua_tolstring(lua_State *L, int idx, size_t *len);
extern const char *lua_pushlstring(lua_State *L, const char *s, size_t len);
extern void lua_pushnil(lua_State *L);
extern long long lua_tointegerx(lua_State *L, int idx, int *isnum);

static int g_wsa_inited = 0;

static void ensure_wsa(void) {
    if (!g_wsa_inited) {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) == 0) {
            g_wsa_inited = 1;
        }
    }
}

static SOCKET connect_with_timeout(const char *host, int port, int connect_ms) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return INVALID_SOCKET;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        closesocket(s);
        return INVALID_SOCKET;
    }

    u_long nonblock = 1;
    ioctlsocket(s, FIONBIO, &nonblock);

    int rc = connect(s, (struct sockaddr *)&addr, sizeof(addr));
    if (rc == SOCKET_ERROR) {
        int err = WSAGetLastError();
        if (err != WSAEWOULDBLOCK) {
            closesocket(s);
            return INVALID_SOCKET;
        }
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(s, &wfds);
        struct timeval tv;
        tv.tv_sec = connect_ms / 1000;
        tv.tv_usec = (connect_ms % 1000) * 1000;
        int sel = select(0, NULL, &wfds, NULL, &tv);
        if (sel <= 0) {
            closesocket(s);
            return INVALID_SOCKET;
        }
        int so_err = 0;
        int so_len = sizeof(so_err);
        getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&so_err, &so_len);
        if (so_err != 0) {
            closesocket(s);
            return INVALID_SOCKET;
        }
    }

    u_long blocking = 0;
    ioctlsocket(s, FIONBIO, &blocking);
    int nodelay = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));
    return s;
}

/* Lua: ime_bridge.query(host, port, json_line, timeout_ms) -> response_line or nil */
static int l_query(lua_State *L) {
    ensure_wsa();
    size_t host_len = 0, payload_len = 0;
    const char *host = lua_tolstring(L, 1, &host_len);
    int port = (int)lua_tointegerx(L, 2, NULL);
    const char *payload = lua_tolstring(L, 3, &payload_len);
    int timeout_ms = (int)lua_tointegerx(L, 4, NULL);
    if (!host || !payload || port <= 0) {
        lua_pushnil(L);
        return 1;
    }
    if (timeout_ms <= 0) timeout_ms = 300;

    SOCKET s = connect_with_timeout(host, port, 15);
    if (s == INVALID_SOCKET) {
        lua_pushnil(L);
        return 1;
    }

    DWORD rcv_to = (DWORD)timeout_ms;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&rcv_to, sizeof(rcv_to));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&rcv_to, sizeof(rcv_to));

    /* Send payload + '\n' */
    size_t sent = 0;
    while (sent < payload_len) {
        int n = send(s, payload + sent, (int)(payload_len - sent), 0);
        if (n <= 0) {
            closesocket(s);
            lua_pushnil(L);
            return 1;
        }
        sent += (size_t)n;
    }
    if (send(s, "\n", 1, 0) != 1) {
        closesocket(s);
        lua_pushnil(L);
        return 1;
    }

    char buf[8192];
    size_t total = 0;
    while (total < sizeof(buf) - 1) {
        int n = recv(s, buf + total, (int)(sizeof(buf) - 1 - total), 0);
        if (n <= 0) break;
        total += (size_t)n;
        if (memchr(buf + total - n, '\n', (size_t)n) != NULL) break;
    }
    closesocket(s);

    if (total == 0) {
        lua_pushnil(L);
        return 1;
    }
    while (total > 0 && (buf[total - 1] == '\n' || buf[total - 1] == '\r')) {
        total--;
    }
    lua_pushlstring(L, buf, total);
    return 1;
}

__declspec(dllexport) int luaopen_ime_bridge(lua_State *L) {
    ensure_wsa();
    lua_createtable(L, 0, 1);
    lua_pushcclosure(L, l_query, 0);
    lua_setfield(L, -2, "query");
    return 1;
}
