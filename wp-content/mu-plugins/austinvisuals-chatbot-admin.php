<?php
/**
 * Plugin Name: Austin Visuals Chatbot Operations Console
 * Description: Independent Google OIDC console, live route/popup settings and conversation moderation.
 * Version: 1.0.0
 *
 * Place in wp-content/mu-plugins/, beside austinvisuals-chatbot.php.
 * Configure Google OAuth via Settings > Chatbot Console Access.
 * Authorized redirect URI: https://austinvisuals.com/chatbot-admin/?oauth_callback=1
 */
if (!defined('ABSPATH')) exit;

const AVCHAT_OPS_PATH = '/chatbot-admin/';
const AVCHAT_OPS_COOKIE = 'avchat_ops_session';

function avchat_ops_conf(): array {
    $c = get_option('avchat_ops_google', []);
    return is_array($c) ? $c : [];
}
function avchat_ops_auth_url(): string {
    return home_url(AVCHAT_OPS_PATH);
}
function avchat_ops_normalize_path(string $path): string {
    $path = '/' . trim($path, '/') . '/';
    return preg_replace('#/+#', '/', $path);
}
function avchat_ops_cookie(string $value, int $expires): void {
    setcookie(AVCHAT_OPS_COOKIE, $value, [
        'expires'=>$expires, 'path'=>'/', 'secure'=>is_ssl(),
        'httponly'=>true, 'samesite'=>'Lax',
    ]);
}
function avchat_ops_identity(): ?array {
    $token = (string)($_COOKIE[AVCHAT_OPS_COOKIE] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) return null;
    $session = get_transient('avops_s_' . hash('sha256', $token));
    if (!is_array($session) || empty($session['email']) || empty($session['sub'])) return null;
    // Revocation takes effect on the next request: never cache the role.
    $allow = avchat_ops_conf()['allow'] ?? [];
    $role = is_array($allow) ? ($allow[strtolower($session['email'])] ?? '') : '';
    if (!in_array($role, ['viewer','moderator','owner'], true)) return null;
    $session['role'] = $role;
    return $session;
}
function avchat_ops_no_cache(): void {
    nocache_headers();
    header('Cache-Control: private, no-store, max-age=0, must-revalidate');
    header('X-Robots-Tag: noindex, nofollow', true);
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
function avchat_ops_base64url_decode(string $txt): string|false {
    return base64_decode(strtr($txt, '-_', '+/'), true);
}
function avchat_ops_asn1_length(int $n): string {
    if ($n < 128) return chr($n);
    $bytes = '';
    while ($n > 0) { $bytes = chr($n & 255) . $bytes; $n >>= 8; }
    return chr(0x80 | strlen($bytes)) . $bytes;
}
function avchat_ops_asn1_sequence(string $body): string {
    return "\x30" . avchat_ops_asn1_length(strlen($body)) . $body;
}
function avchat_ops_asn1_integer(string $value): string {
    $value = ltrim($value, "\x00");
    if ($value === '') $value = "\x00";
    if (ord($value[0]) & 0x80) $value = "\x00" . $value;
    return "\x02" . avchat_ops_asn1_length(strlen($value)) . $value;
}
function avchat_ops_rsa_jwk_to_pem(array $jwk): ?string {
    // Google's JWKS provides n/e rather than an x5c certificate.
    $n = avchat_ops_base64url_decode((string)($jwk['n'] ?? ''));
    $e = avchat_ops_base64url_decode((string)($jwk['e'] ?? ''));
    if ($n === false || $e === false || strlen($n) < 128 || strlen($e) < 1) return null;
    $rsa = avchat_ops_asn1_sequence(avchat_ops_asn1_integer($n) . avchat_ops_asn1_integer($e));
    $alg = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";
    $bit = "\x00" . $rsa;
    $subject = avchat_ops_asn1_sequence($alg . "\x03" . avchat_ops_asn1_length(strlen($bit)) . $bit);
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($subject), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
function avchat_ops_verify_id_token(string $jwt, string $client_id, string $nonce): ?array {
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) return null;
    $header = json_decode((string)avchat_ops_base64url_decode($parts[0]), true);
    $claims = json_decode((string)avchat_ops_base64url_decode($parts[1]), true);
    if (!is_array($header) || !is_array($claims) || ($header['alg'] ?? '') !== 'RS256') return null;
    if (!is_string($header['kid'] ?? null) || !$header['kid']) return null;
    if (!in_array($claims['iss'] ?? '', ['accounts.google.com','https://accounts.google.com'], true)) return null;
    if (($claims['aud'] ?? '') !== $client_id || ($claims['nonce'] ?? '') !== $nonce) return null;
    if ((int)($claims['exp'] ?? 0) <= time() || (int)($claims['iat'] ?? 0) > time()+120) return null;
    if (!in_array($claims['email_verified'] ?? false, [true, 'true'], true)) return null;
    if (empty($claims['sub']) || !is_email((string)($claims['email'] ?? ''))) return null;
    $keys = get_transient('avchat_ops_google_jwks');
    if (!is_array($keys)) {
        $r = wp_remote_get('https://www.googleapis.com/oauth2/v3/certs', ['timeout'=>12, 'redirection'=>0]);
        if (is_wp_error($r) || wp_remote_retrieve_response_code($r) !== 200) return null;
        $keys = json_decode(wp_remote_retrieve_body($r), true);
        if (!is_array($keys) || !is_array($keys['keys'] ?? null)) return null;
        set_transient('avchat_ops_google_jwks', $keys, HOUR_IN_SECONDS);
    }
    $kid_found = false;
    foreach (($keys['keys'] ?? []) as $k) {
        if (($k['kid'] ?? '') === $header['kid']) { $kid_found = true; break; }
    }
    if (!$kid_found) {
        $r = wp_remote_get('https://www.googleapis.com/oauth2/v3/certs', ['timeout'=>12,'redirection'=>0]);
        if (!is_wp_error($r) && wp_remote_retrieve_response_code($r) === 200) {
            $fresh = json_decode(wp_remote_retrieve_body($r), true);
            if (is_array($fresh) && is_array($fresh['keys'] ?? null)) {
                $keys = $fresh;
                set_transient('avchat_ops_google_jwks', $keys, HOUR_IN_SECONDS);
            }
        }
    }
    $sig = avchat_ops_base64url_decode($parts[2]);
    if ($sig === false) return null;
    foreach ($keys['keys'] as $key) {
        if (($key['kid'] ?? '') !== $header['kid']) continue;
        $pem = avchat_ops_rsa_jwk_to_pem($key);
        if ($pem && openssl_verify($parts[0] . '.' . $parts[1], $sig, $pem, OPENSSL_ALGO_SHA256) === 1) return $claims;
    }
    return null;
}
function avchat_ops_redirect(string $url): void {
    wp_redirect($url, 302, 'Austin Visuals Chatbot Console');
    exit;
}
/**
 * Browser-bound, tamper-evident OAuth state.
 *
 * WP Engine can route the Google redirect and its callback to different PHP
 * workers/object-cache nodes. A transient created by the first request may
 * therefore be unavailable to the callback even when the cookie survived.
 * Keep state and OIDC nonce in a five-minute HMAC-authenticated, HttpOnly
 * SameSite=Lax cookie instead. The HMAC uses WordPress' server-side auth salt;
 * neither a secret nor an authorization code is exposed to JavaScript.
 * Google's authorization code remains single-use.
 */
function avchat_ops_login_cookie(string $state, string $nonce, int $issued_at): string {
    $body = 'v2.' . $state . '.' . $nonce . '.' . $issued_at;
    return $body . '.' . hash_hmac('sha256', $body, wp_salt('auth'));
}
function avchat_ops_valid_login_cookie(string $cookie, string $returned_state): ?string {
    if (!preg_match('/^[a-f0-9]{48}$/D', $returned_state)) return null;
    $parts = explode('.', $cookie);
    if (count($parts) !== 5 || $parts[0] !== 'v2') return null;
    [$version, $state, $nonce, $issued, $signature] = $parts;
    if (!preg_match('/^[a-f0-9]{48}$/D', $state) ||
        !preg_match('/^[a-f0-9]{48}$/D', $nonce) ||
        !preg_match('/^[0-9]{10}$/D', $issued) ||
        !preg_match('/^[a-f0-9]{64}$/D', $signature)) return null;
    if (!hash_equals($state, $returned_state)) return null;
    $timestamp = (int)$issued;
    if ($timestamp > time() + 30 || time() - $timestamp > 300) return null;
    $body = 'v2.' . $state . '.' . $nonce . '.' . $issued;
    $expected = hash_hmac('sha256', $body, wp_salt('auth'));
    if (!hash_equals($expected, $signature)) return null;
    return $nonce;
}

function avchat_ops_login(): void {
    $config = avchat_ops_conf();
    if (empty($config['client_id']) || empty($config['client_secret'])) {
        status_header(503);
        wp_die('Google OAuth is not configured. A WordPress administrator must open Settings > Chatbot Console Access.', 'Console setup required', ['response'=>503]);
    }
    if (!is_ssl()) wp_die('HTTPS is required for the admin console.', 'HTTPS required', ['response'=>403]);
    $state = bin2hex(random_bytes(24));
    $nonce = bin2hex(random_bytes(24));
    $login_cookie = avchat_ops_login_cookie($state, $nonce, time());
    setcookie('avchat_ops_oauth', $login_cookie, [
        'expires'=>time()+300,'path'=>AVCHAT_OPS_PATH,'secure'=>true,
        'httponly'=>true,'samesite'=>'Lax',
    ]);
    $url = add_query_arg([
        'client_id'=>$config['client_id'], 'redirect_uri'=>avchat_ops_auth_url() . '?oauth_callback=1',
        'response_type'=>'code', 'scope'=>'openid email profile', 'prompt'=>'select_account',
        'state'=>$state, 'nonce'=>$nonce,
    ], 'https://accounts.google.com/o/oauth2/v2/auth');
    avchat_ops_redirect($url);
}
function avchat_ops_callback(): void {
    $state = sanitize_text_field(wp_unslash($_GET['state'] ?? ''));
    $code = sanitize_text_field(wp_unslash($_GET['code'] ?? ''));
    $login_cookie = (string)($_COOKIE['avchat_ops_oauth'] ?? '');
    $nonce = avchat_ops_valid_login_cookie($login_cookie, $state);
    // Consume this attempt's browser-side secret before token exchange. The
    // short-lived Google code is single-use, preventing replay after exchange.
    setcookie('avchat_ops_oauth', '', ['expires'=>time()-3600,'path'=>AVCHAT_OPS_PATH,'secure'=>true,'httponly'=>true,'samesite'=>'Lax']);
    if (!$code || $nonce === null) {
        wp_die('The Google sign-in request expired or could not be verified. Please start a fresh sign-in.', 'Login rejected', ['response'=>403]);
    }
    $config = avchat_ops_conf();
    $r = wp_remote_post('https://oauth2.googleapis.com/token', [
        'timeout'=>15, 'redirection'=>0, 'body'=>[
            'code'=>$code, 'client_id'=>$config['client_id'] ?? '',
            'client_secret'=>$config['client_secret'] ?? '',
            'redirect_uri'=>avchat_ops_auth_url() . '?oauth_callback=1',
            'grant_type'=>'authorization_code',
        ],
    ]);
    $tokens = !is_wp_error($r) && wp_remote_retrieve_response_code($r) === 200
        ? json_decode(wp_remote_retrieve_body($r), true) : null;
    $claims = is_array($tokens) && is_string($tokens['id_token'] ?? null)
        ? avchat_ops_verify_id_token($tokens['id_token'], (string)$config['client_id'], $nonce) : null;
    if (!$claims) wp_die('Google identity verification failed.', 'Login rejected', ['response'=>403]);
    $email = strtolower((string)$claims['email']);
    $allow = $config['allow'] ?? [];
    if (!is_array($allow) || !in_array($allow[$email] ?? '', ['owner','moderator','viewer'], true)) {
        wp_die('This Google account is not authorized for the chatbot console.', 'Access denied', ['response'=>403]);
    }
    $token = bin2hex(random_bytes(32));
    set_transient('avops_s_' . hash('sha256', $token), [
        'email'=>$email, 'sub'=>(string)$claims['sub'], 'csrf'=>bin2hex(random_bytes(24)),
    ], 8*HOUR_IN_SECONDS);
    avchat_ops_cookie($token, time()+8*HOUR_IN_SECONDS);
    avchat_ops_redirect(avchat_ops_auth_url());
}
function avchat_ops_logout(): void {
    $token = (string)($_COOKIE[AVCHAT_OPS_COOKIE] ?? '');
    if (preg_match('/^[a-f0-9]{64}$/', $token)) delete_transient('avops_s_' . hash('sha256', $token));
    avchat_ops_cookie('', time()-3600);
    avchat_ops_redirect(avchat_ops_auth_url());
}

// Ordinary WordPress administrators configure the Google OAuth client and
// allowlist here; OAuth is still compulsory to enter the standalone console.
add_action('admin_menu', static function (): void {
    add_options_page('Chatbot Console Access','Chatbot Console Access','manage_options','avchat-console-access','avchat_ops_wp_settings');
});
function avchat_ops_wp_settings(): void {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    $c = avchat_ops_conf();
    $lines = [];
    foreach (($c['allow'] ?? []) as $email=>$role) $lines[] = $email . '|' . $role;
    echo '<div class="wrap"><h1>Chatbot Console Access</h1>';
    echo '<p>Standalone console: <a href="'.esc_url(avchat_ops_auth_url()).'" target="_blank" rel="noopener">'.esc_html(avchat_ops_auth_url()).'</a></p>';
    echo '<p>Google Cloud Console → OAuth client → Web application. Authorized redirect URI: <code>'.esc_html(avchat_ops_auth_url().'?oauth_callback=1').'</code></p>';
    echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'">';
    echo '<input type="hidden" name="action" value="avchat_ops_save_google">';
    wp_nonce_field('avchat_ops_save_google');
    echo '<table class="form-table"><tr><th>Google Client ID</th><td><input class="regular-text" name="client_id" value="'.esc_attr($c['client_id'] ?? '').'" required></td></tr>';
    echo '<tr><th>Google Client Secret</th><td><input class="regular-text" name="client_secret" type="password" autocomplete="new-password" placeholder="Leave blank to preserve existing secret">';
    echo '<p class="description">Stored in the WordPress options database; never embed in frontend JavaScript or Git.</p></td></tr>';
    echo '<tr><th>Allowed Google emails</th><td><textarea name="allow" rows="10" cols="65">'.esc_textarea(implode("\n", $lines)).'</textarea>';
    echo '<p class="description">One email|role per line. Roles: owner, moderator, viewer. At least one owner is required.</p></td></tr></table>';
    submit_button('Save Google authentication');
    echo '</form><p>For WP-CLI: <code>wp option get avchat_ops_google --format=json</code>. To switch public mode: <code>wp option update avchat_ops_mode developer</code> or <code>production</code>.</p></div>';
}
add_action('admin_post_avchat_ops_save_google', static function (): void {
    if (!current_user_can('manage_options')) wp_die('Forbidden', '', ['response'=>403]);
    check_admin_referer('avchat_ops_save_google');
    $old = avchat_ops_conf();
    $client_id = sanitize_text_field(wp_unslash($_POST['client_id'] ?? ''));
    $secret = trim((string)wp_unslash($_POST['client_secret'] ?? ''));
    $allow = []; $owners = 0;
    foreach (preg_split('/\r?\n/', (string)wp_unslash($_POST['allow'] ?? '')) as $line) {
        $line = trim($line); if (!$line) continue;
        $parts = array_map('trim', explode('|', $line, 2));
        $email = strtolower(sanitize_email($parts[0] ?? ''));
        $role = strtolower($parts[1] ?? 'viewer');
        if (!is_email($email) || !in_array($role, ['viewer','moderator','owner'], true)) continue;
        $allow[$email] = $role;
    }
    foreach ($allow as $role) if ($role === 'owner') $owners++;
    if (!$owners) wp_die('At least one Google email must have the owner role.', '', ['response'=>400]);
    update_option('avchat_ops_google', [
        'client_id'=>$client_id,
        'client_secret'=>$secret !== '' ? $secret : ($old['client_secret'] ?? ''),
        'allow'=>$allow,
    ], false);
    wp_safe_redirect(admin_url('options-general.php?page=avchat-console-access&updated=1'));
    exit;
});

function avchat_ops_routes(): array {
    $routes = [];
    $put = static function ($url, $title) use (&$routes): void {
        if (!$url || !is_string($url)) return;
        $host = strtolower((string)wp_parse_url($url, PHP_URL_HOST));
        $ours = strtolower((string)wp_parse_url(home_url('/'), PHP_URL_HOST));
        if ($host !== $ours) return;
        $path = avchat_ops_normalize_path((string)wp_parse_url($url, PHP_URL_PATH));
        if ($path === '/chatbot-admin/') return;
        $routes[$path] = ['path'=>$path,'title'=>$title,'url'=>$url];
    };
    $put(home_url('/'), 'Homepage');
    $put(home_url('/chatbot-test-v3/'), 'Chatbot test page');
    foreach (get_post_types(['public'=>true], 'names') as $type) {
        if ($type === 'attachment') continue;
        $ids = get_posts(['post_type'=>$type,'post_status'=>'publish','numberposts'=>-1,
                          'fields'=>'ids', 'suppress_filters'=>true]);
        foreach ($ids as $id) $put(get_permalink($id), get_the_title($id) . ' · ' . $type);
        if ($type !== 'page' && $type !== 'post') {
            $archive = get_post_type_archive_link($type);
            if ($archive) $put($archive, ucfirst($type) . ' archive');
        }
    }
    foreach (get_taxonomies(['public'=>true], 'names') as $taxonomy) {
        $terms = get_terms(['taxonomy'=>$taxonomy,'hide_empty'=>false,'fields'=>'all']);
        if (is_wp_error($terms)) continue;
        foreach ($terms as $term) {
            $url = get_term_link($term);
            if (!is_wp_error($url)) $put($url, $term->name . ' · ' . $taxonomy);
        }
    }
    // Include explicitly configured custom or plugin-generated paths that are
    // not represented by a published post or a taxonomy term.
    $saved = get_option('avchat_ops_routes', []);
    if (is_array($saved)) foreach (array_keys($saved) as $path) {
        $path = avchat_ops_normalize_path((string)$path);
        if (!isset($routes[$path]) && $path !== '/chatbot-admin/') {
            $routes[$path] = ['path'=>$path,'title'=>'Custom / plugin-generated route',
                              'url'=>home_url($path)];
        }
    }
    ksort($routes);
    return array_values($routes);
}
function avchat_ops_backend(array $payload): array {
    $shared = function_exists('av_chat_gateway_secret') ? av_chat_gateway_secret() : '';
    if (!$shared) return ['ok'=>false,'error'=>'Chatbot gateway is unavailable'];
    $admin_secret = hash_hmac('sha256','austinvisuals-console-v1',$shared);
    $r = wp_remote_post(rtrim(AV_CHAT_GATEWAY_URL,'/') . '/v1/admin/console', [
        'timeout'=>28, 'redirection'=>0,
        'headers'=>['Content-Type'=>'application/json','X-AV-Chat-Admin-Secret'=>$admin_secret],
        'body'=>wp_json_encode($payload),
    ]);
    if (is_wp_error($r)) return ['ok'=>false,'error'=>'Gateway connection error'];
    $data = json_decode(wp_remote_retrieve_body($r), true);
    return is_array($data) ? $data : ['ok'=>false,'error'=>'Invalid gateway response'];
}

function avchat_ops_invalidate_public_cache(): void {
    // WP Engine full-page caching can otherwise keep yesterday's popup/mode
    // despite newly saved route settings on the origin WordPress process.
    if (class_exists('wpecommon') && method_exists('wpecommon', 'purge_varnish_cache')) {
        try { wpecommon::purge_varnish_cache(); }
        catch (Throwable $e) { error_log('Chatbot console cache purge: ' . get_class($e)); }
    }
}
function avchat_ops_ajax(): void {
    avchat_ops_no_cache();
    $identity = avchat_ops_identity();
    if (!$identity) wp_send_json_error(['error'=>'Google login required'], 401);
    $csrf = sanitize_text_field(wp_unslash($_POST['csrf'] ?? ''));
    if (!$csrf || !hash_equals($identity['csrf'], $csrf)) wp_send_json_error(['error'=>'Invalid request token'], 403);
    $task = sanitize_key($_POST['task'] ?? '');
    $role = $identity['role'];
    $actor = $identity['email'];
    if ($task === 'routes') wp_send_json_success(['routes'=>avchat_ops_routes()]);
    if ($task === 'save_global') {
        if ($role !== 'owner') wp_send_json_error(['error'=>'Owner access required'], 403);
        $mode = sanitize_text_field(wp_unslash($_POST['mode'] ?? ''));
        if (!in_array($mode,['developer','production'],true)) wp_send_json_error(['error'=>'Invalid mode'],400);
        update_option('avchat_ops_mode', $mode, false);
        $popup = [
            'enabled' => ($_POST['enabled'] ?? '') === '1',
            'seconds' => max(0,min(3600,(int)($_POST['seconds'] ?? 20))),
            'text' => mb_substr(sanitize_textarea_field(wp_unslash($_POST['text'] ?? '')),0,280),
            'background' => sanitize_hex_color(wp_unslash($_POST['background'] ?? '#ffffff')) ?: '#ffffff',
            'color' => sanitize_hex_color(wp_unslash($_POST['color'] ?? '#202b3c')) ?: '#202b3c',
            'font' => max(10,min(24,(float)($_POST['font'] ?? 13.5))),
        ];
        update_option('avchat_ops_popup_defaults', $popup, false);
        avchat_ops_invalidate_public_cache();
        wp_send_json_success(['mode'=>$mode]);
    }
    if ($task === 'save_route') {
        if ($role !== 'owner') wp_send_json_error(['error'=>'Owner access required'], 403);
        $path = avchat_ops_normalize_path(sanitize_text_field(wp_unslash($_POST['path'] ?? '')));
        if ($path === '/chatbot-admin/' || strlen($path) > 700 || !preg_match('#^/[a-zA-Z0-9/_~.%-]*/$#', $path)) {
            wp_send_json_error(['error'=>'Invalid route'],400);
        }
        $all = get_option('avchat_ops_routes', []);
        if (!is_array($all)) $all = [];
        $all[$path] = [
            'chat_enabled'=>($_POST['chat_enabled'] ?? '')==='1',
            'popup_enabled'=>($_POST['popup_enabled'] ?? '')==='1',
            'popup_seconds'=>max(0,min(3600,(int)($_POST['popup_seconds'] ?? 20))),
            'popup_text'=>mb_substr(sanitize_textarea_field(wp_unslash($_POST['popup_text'] ?? '')),0,280),
            'popup_background'=>sanitize_hex_color(wp_unslash($_POST['popup_background'] ?? '#ffffff')) ?: '#ffffff',
            'popup_color'=>sanitize_hex_color(wp_unslash($_POST['popup_color'] ?? '#202b3c')) ?: '#202b3c',
            'popup_font'=>max(10,min(24,(float)($_POST['popup_font'] ?? 13.5))),
        ];
        update_option('avchat_ops_routes', $all, false);
        avchat_ops_invalidate_public_cache();
        wp_send_json_success(['path'=>$path]);
    }
    if (!in_array($task, ['sessions','session','ips','bans','ban','unban'], true)) {
        wp_send_json_error(['error'=>'Unknown action'],400);
    }
    if (in_array($task,['ban','unban'],true) && !in_array($role,['moderator','owner'],true)) {
        wp_send_json_error(['error'=>'Moderator role required'],403);
    }
    $input = [
        'action'=>$task,'actor'=>$actor,'role'=>$role,
        'limit'=>max(1,min(100,(int)($_POST['limit'] ?? 35))),
        'offset'=>max(0,(int)($_POST['offset'] ?? 0)),
        'search'=>sanitize_text_field(wp_unslash($_POST['search'] ?? '')),
        'session_id'=>sanitize_text_field(wp_unslash($_POST['session_id'] ?? '')),
        'ip'=>sanitize_text_field(wp_unslash($_POST['ip'] ?? '')),
        'reason'=>sanitize_textarea_field(wp_unslash($_POST['reason'] ?? '')),
        'hours'=>max(0,(int)($_POST['hours'] ?? 0)),
    ];
    $result = avchat_ops_backend($input);
    if (empty($result['ok'])) wp_send_json_error(['error'=>$result['error'] ?? 'Backend request failed'], 502);
    wp_send_json_success($result);
}
add_action('wp_ajax_avchat_ops_action', 'avchat_ops_ajax');
add_action('wp_ajax_nopriv_avchat_ops_action', 'avchat_ops_ajax');

add_action('template_redirect', static function (): void {
    $path = avchat_ops_normalize_path((string)wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));
    if ($path !== AVCHAT_OPS_PATH) return;
    avchat_ops_no_cache();
    if (!is_ssl()) { status_header(403); exit('HTTPS required'); }
    if (isset($_GET['oauth_callback'])) { avchat_ops_callback(); return; }
    if (isset($_GET['logout'])) { avchat_ops_logout(); return; }
    if (isset($_GET['login'])) { avchat_ops_login(); return; }
    $identity = avchat_ops_identity();
    if (!$identity) {
        status_header(200);
        echo '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chatbot Console</title>';
        echo '<style>body{font:16px system-ui;background:#0c1324;color:#eaf0ff;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#17223a;padding:40px;border-radius:18px;max-width:410px}a{display:inline-block;padding:13px 22px;background:#417cf0;color:white;border-radius:9px;text-decoration:none}</style></head><body>';
        echo '<main><h1>Chatbot Operations</h1><p>Private Austin Visuals console. Sign in using an approved Google account.</p><p><a href="'.esc_url(add_query_arg('login','1',avchat_ops_auth_url())).'">Sign in with Google</a></p></main></body></html>';
        exit;
    }
    avchat_ops_screen($identity);
    exit;
}, 0);

function avchat_ops_screen(array $identity): void {
    $defaults = get_option('avchat_ops_popup_defaults', []);
    $defaults = is_array($defaults) ? $defaults : [];
    $mode = get_option('avchat_ops_mode','developer');
    $rows = avchat_ops_routes();
    $rules = get_option('avchat_ops_routes', []);
    if (!is_array($rules)) $rules=[];
    $jsdata = [
        'endpoint'=>admin_url('admin-ajax.php'), 'csrf'=>$identity['csrf'],
        'routes'=>$rows, 'rules'=>$rules, 'defaults'=>$defaults,
        'mode'=>$mode, 'role'=>$identity['role'], 'email'=>$identity['email'],
    ];
    $encoded = wp_json_encode($jsdata, JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT);
    ?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Austin Visuals · Chatbot Operations</title>
<style>
:root{color-scheme:dark;--bg:#0b1220;--panel:#161f32;--line:#303d56;--text:#f1f5fc;--muted:#a4b2c9;--accent:#6294fa}
*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font:14px system-ui,-apple-system,sans-serif;margin:0;line-height:1.5}
header{padding:22px 28px;border-bottom:1px solid var(--line);display:flex;gap:24px;align-items:center;justify-content:space-between}
header h1{font-size:21px;margin:0}header small,.muted{color:var(--muted)}a{color:#a9c6ff}
nav{display:flex;gap:8px;padding:15px 26px;flex-wrap:wrap;border-bottom:1px solid var(--line)}button,input,textarea,select{font:inherit}
button,.tab{background:#283851;color:var(--text);border:1px solid #465878;border-radius:8px;padding:9px 14px;cursor:pointer}
button:hover,.tab.active{background:#3260a1}.danger{background:#652938;border-color:#ac4d59}.ok{background:#245542}
main{padding:22px 26px;max-width:1500px;margin:auto}.section{display:none}.section.active{display:block}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:15px}
input,textarea,select{background:#101a2c;color:var(--text);border:1px solid #475877;border-radius:7px;padding:9px;max-width:100%}
input[type=checkbox]{width:17px;height:17px;vertical-align:middle}textarea{width:100%;resize:vertical}input[type=search]{min-width:270px}
label{display:block;margin:8px 0 4px}table{width:100%;border-collapse:collapse}td,th{padding:11px 9px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}tr:hover{background:#1b2a40}
.scroll{max-height:65vh;overflow:auto}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 18px}
.thread{max-height:65vh;overflow:auto;white-space:pre-wrap}.message{padding:10px 14px;border-left:3px solid var(--accent);background:#121d30;margin:8px 0;border-radius:6px}
.message.user{border-color:#ddad69}.message.system{border-color:#728198}.message.human{border-color:#78ca9d}
.route-row textarea{min-width:240px;height:55px}.route-row input[type=number]{width:82px}
#notice{padding:11px 20px;color:#c9e6ff;min-height:38px}h2{margin-top:0;font-size:20px}h3{margin-bottom:9px}
@media(max-width:750px){main{padding:12px}header{padding:16px;flex-direction:column;align-items:start}.scroll{overflow:auto}td,th{min-width:90px}}
</style></head><body>
<header><div><h1>Chatbot Operations</h1><small>Private dashboard · Austin Visuals · No WordPress theme</small></div>
<div><span id="identity"></span> · <a href="<?php echo esc_url(add_query_arg('logout','1',avchat_ops_auth_url())); ?>">Sign out</a></div></header>
<nav><button class="tab active" data-tab="sessions">Conversations</button><button class="tab" data-tab="visitors">IPs & bans</button><button class="tab" data-tab="routes">Routes & popup messages</button><button class="tab" data-tab="global">Developer / production</button></nav>
<div id="notice" role="status"></div><main>
<section class="section active" id="sessions"><div class="panel"><h2>All recorded conversations</h2><div class="controls"><input id="session-search" type="search" placeholder="Search session, IP, email, or URL"><button id="search-button">Search</button><button id="refresh-sessions">Refresh</button><button id="session-next">Next page</button></div><div class="scroll"><table><thead><tr><th>Updated</th><th>Session</th><th>Visitor IP</th><th>Messages</th><th>Leads</th><th>Route / status</th></tr></thead><tbody id="sessions-body"></tbody></table></div></div>
<div class="panel" id="detail-panel" hidden><div class="controls"><h2>Conversation details</h2><button id="export-session">Export JSON</button></div><div id="session-detail"></div></div></section>
<section class="section" id="visitors"><div class="panel"><h2>Visitor IP addresses</h2><p class="muted">Historical conversations that stored only a one-way IP hash cannot reveal their original IP. New sessions can be grouped by the actual trusted address.</p><div class="controls"><button id="refresh-ips">Refresh visitors</button><button id="refresh-bans">Ban history</button></div><div class="scroll"><table><thead><tr><th>Address</th><th>Sessions</th><th>Requests</th><th>Last seen</th><th>Action</th></tr></thead><tbody id="ips-body"></tbody></table></div></div>
<div class="panel"><h3>Manual IP ban</h3><div class="controls"><input id="ban-ip" placeholder="IPv4 or IPv6"><input id="ban-reason" placeholder="Reason for moderation"><input id="ban-hours" type="number" min="0" value="24" style="width:110px" title="0 = permanent"><button id="ban-submit" class="danger">Ban IP</button></div><small class="muted">Duration in hours (0 = indefinite). IP bans apply to the chatbot, not the entire site.</small><pre id="bans-output"></pre></div></section>
<section class="section" id="routes"><div class="panel"><h2>Live routes and proactive popup bubbles</h2><p class="muted">Automatically reads all published WordPress posts, pages, public taxonomies, and archives. Newly published routes use global defaults until customized. Save each changed row.</p><div class="controls"><input id="route-search" type="search" placeholder="Filter route URL or title"><button id="reload-routes">Reload routes</button><input id="new-route" placeholder="/custom-route/" style="min-width:170px"><button id="add-route">Add route</button><span id="route-count"></span></div><div class="scroll"><table><thead><tr><th>Route</th><th>Chatbot visible</th><th>Popup on</th><th>Wait (seconds)</th><th>Bubble text</th><th>Text color</th><th>Background</th><th>Font (px)</th><th>Save</th></tr></thead><tbody id="routes-body"></tbody></table></div></div></section>
<section class="section" id="global"><div class="panel"><h2>Global visibility and default popup</h2><p><strong>Developer mode:</strong> chatbot appears only on <a href="<?php echo esc_url(home_url('/chatbot-test-v3/')); ?>" target="_blank">/chatbot-test-v3/</a>. <strong>Production mode:</strong> chatbot appears on public routes unless that route's chatbot toggle is off.</p>
<p class="muted">This mode controls where Jenn appears, not the independent sales/SMS delivery switch (AV_CHAT_DELIVERY_MODE).</p>
<label>Visibility mode<select id="public-mode"><option value="developer">Developer — test route only</option><option value="production">Production — public website</option></select></label>
<label><input type="checkbox" id="global-popup"> Popup bubbles enabled by default</label>
<label>Popup delay in seconds<input id="global-seconds" type="number" min="0" max="3600" value="20"></label>
<label>Default popup text<textarea id="global-text" rows="3" maxlength="280"></textarea></label>
<label>Text color <input type="color" id="global-color" value="#202b3c"></label>
<label>Bubble background <input type="color" id="global-background" value="#ffffff"></label>
<label>Font size (px) <input type="number" id="global-font" min="10" max="24" step="0.5" value="13.5"></label><p><button class="ok" id="save-global">Save global settings</button></p>
<p class="muted">Google allowlist / OAuth client settings: WordPress Dashboard → Settings → Chatbot Console Access, or WP-CLI from an authorized server terminal.</p></div></section>
</main>
<script>
const C = <?php echo $encoded; ?>;
const $ = id => document.getElementById(id);
const notice = text => { $('notice').textContent=String(text||''); };
const elt=(tag,text)=>{const x=document.createElement(tag); if(text!==undefined)x.textContent=String(text??''); return x;};
const dt=x=>x?new Date(Number(x)*1000).toLocaleString():'—';
$('identity').textContent=C.email+' ('+C.role+')';
for(const btn of document.querySelectorAll('.tab'))btn.onclick=()=>{
 document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===btn));
 document.querySelectorAll('.section').forEach(x=>x.classList.toggle('active',x.id===btn.dataset.tab));
 if(btn.dataset.tab==='sessions')loadSessions(); if(btn.dataset.tab==='visitors')loadIps();
 if(btn.dataset.tab==='routes')renderRoutes();
};
async function api(task, fields={}){
 const params=new URLSearchParams({action:'avchat_ops_action',csrf:C.csrf,task,...fields});
 const r=await fetch(C.endpoint,{method:'POST',body:params,credentials:'same-origin',cache:'no-store'});
 const json=await r.json(); if(!r.ok||!json.success)throw Error(json.data?.error||'Request failed');
 return json.data;
}
async function run(task,fields){try{notice('');return await api(task,fields);}catch(e){notice(e.message);throw e;}}
let page=0, currentDetail=null;
async function loadSessions(){const v=await run('sessions',{search:$('session-search').value,offset:page*35,limit:35});
 const body=$('sessions-body');body.replaceChildren();
 for(const s of v.rows||[]){const tr=elt('tr');
 const cols=[dt(s.updated_at),s.id,s.ips||'(historical hash only)',s.message_count,s.lead_count,(s.page_url||'')+' · '+s.status];
 cols.forEach((c,i)=>{const td=elt('td');if(i===1){const b=elt('button',c);b.onclick=()=>loadDetail(s.id);td.append(b);}else td.textContent=String(c);tr.append(td);});body.append(tr);
 } notice('Conversations: '+v.total+' · page '+(page+1));}
async function loadDetail(id){const r=await run('session',{session_id:id}); currentDetail=r;
 $('detail-panel').hidden=false;const box=$('session-detail');box.replaceChildren();
 const info=elt('p',`Session ${id} · ${r.session.status} · ${r.session.page_url} · created ${dt(r.session.created_at)}`);box.append(info);
 const ips=elt('p','IP history: '+(r.ips.map(x=>x.ip+' ('+dt(x.last_seen)+')').join(', ')||'No raw IP in legacy records'));box.append(ips);
 for(const item of r.messages||[]){const d=elt('div');d.className='message '+item.role;
 d.append(elt('strong',item.role+' · '+dt(item.created_at)+' · '+(item.model||item.provider||'')));
 d.append(elt('div',item.content));box.append(d);}
 for(const [heading,list] of [['Retrieved sources',r.sources],['Lookup & audit events',r.events],['Submitted leads',r.leads],['Contact forms',r.forms],['Lead drafts',r.drafts],['Notifications',r.notifications]]){
 const h=elt('h3',heading+' ('+(list||[]).length+')');box.append(h);
 const pre=elt('pre',JSON.stringify(list||[],null,2));pre.style.whiteSpace='pre-wrap';pre.style.overflowWrap='anywhere';box.append(pre);
 } $('detail-panel').scrollIntoView({behavior:'smooth'});
}
$('export-session').onclick=()=>{if(!currentDetail)return;const blob=new Blob([JSON.stringify(currentDetail,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=elt('a');a.href=url;a.download='avchat-session-'+currentDetail.session.id+'.json';a.click();URL.revokeObjectURL(url);};
$('search-button').onclick=()=>{page=0;loadSessions();};
$('session-search').onkeydown=e=>{if(e.key==='Enter'){$('search-button').click();}};
$('refresh-sessions').onclick=()=>loadSessions();$('session-next').onclick=()=>{page++;loadSessions();};
async function loadIps(){const v=await run('ips',{});const body=$('ips-body');body.replaceChildren();
 for(const ip of v.rows||[]){const tr=elt('tr');[ip.ip,ip.sessions,ip.request_count,dt(ip.last_seen)].forEach(x=>tr.append(elt('td',x)));
 const td=elt('td');const b=elt('button',ip.banned?'Banned':'Ban');b.disabled=!!ip.banned||C.role==='viewer';b.onclick=()=>{$('ban-ip').value=ip.ip;$('ban-reason').focus();};td.append(b);tr.append(td);body.append(tr);}
}
$('refresh-ips').onclick=loadIps;
$('ban-submit').onclick=async()=>{if(C.role==='viewer')return; const ip=$('ban-ip').value,reason=$('ban-reason').value;
 if(!reason.trim()||!confirm('Ban chatbot requests from '+ip+'?'))return;
 await run('ban',{ip,reason,hours:$('ban-hours').value});notice('IP banned: '+ip);loadIps();};
// Unban via button created alongside ban history; requires moderator role.
$('refresh-bans').addEventListener('click',async()=>{const data=await api('bans',{});const box=$('bans-output');box.replaceChildren();
 for(const row of data.rows){const line=elt('div',row.ip+' · '+row.reason+' · '+dt(row.created_at)+' · '+(row.revoked_at?'revoked':'active')+' ');
 if(!row.revoked_at&&C.role!=='viewer'){const b=elt('button','Unban');b.onclick=async()=>{if(confirm('Unban '+row.ip+'?')){await run('unban',{ip:row.ip});$('refresh-bans').click();loadIps();}};line.append(b);}box.append(line);}
});
const dp=C.defaults||{};
$('public-mode').value=C.mode||'developer';$('global-popup').checked=dp.enabled!==false;
$('global-seconds').value=dp.seconds??20;
$('global-text').value=dp.text||"Hi! I'm Jenn. Have a project in mind? Tell me what you're creating and I'll help you get it in front of our team.";
$('global-color').value=dp.color||'#202b3c';
$('global-background').value=dp.background||'#ffffff';
$('global-font').value=dp.font??13.5;
$('save-global').disabled=C.role!=='owner';
$('save-global').onclick=async()=>{const mode=$('public-mode').value;
 if(mode==='production'&&!confirm('Make Jenn available to public visitors across the website?'))return;
 await run('save_global',{mode,enabled:$('global-popup').checked?'1':'0',seconds:$('global-seconds').value,text:$('global-text').value,
 color:$('global-color').value,background:$('global-background').value,font:$('global-font').value});notice('Global settings saved');};
let routeList=C.routes||[];
function renderRoutes(){const term=$('route-search').value.toLowerCase().trim();const body=$('routes-body');body.replaceChildren();
 const visible=routeList.filter(r=>((r.path||'')+' '+(r.title||'')).toLowerCase().includes(term));
 $('route-count').textContent=visible.length+' / '+routeList.length+' routes';
 for(const r of visible){const cfg=C.rules[r.path]||{},tr=elt('tr');tr.className='route-row';
 const title=elt('td');title.append(elt('div',r.title||r.path));const link=elt('a',r.path);link.href=r.url;link.target='_blank';link.rel='noopener';title.append(link);tr.append(title);
 const field=(tag,type,value)=>{const e=elt(tag);if(tag==='input'){e.type=type;if(type==='checkbox')e.checked=value;else e.value=value;}else e.value=value;return e;};
 const chat=field('input','checkbox',cfg.chat_enabled!==false),popup=field('input','checkbox',cfg.popup_enabled??(dp.enabled!==false));
 const secs=field('input','number',cfg.popup_seconds??dp.seconds??20);secs.min='0';secs.max='3600';
 const msg=elt('textarea');msg.maxLength=280;msg.value=cfg.popup_text??dp.text??$('global-text').value;
 const color=field('input','color',cfg.popup_color??dp.color??'#202b3c');
 const background=field('input','color',cfg.popup_background??dp.background??'#ffffff');
 const font=field('input','number',cfg.popup_font??dp.font??13.5);font.min='10';font.max='24';font.step='0.5';
 for(const control of [chat,popup,secs,msg,color,background,font]){const td=elt('td');td.append(control);tr.append(td);}
 const save=elt('button','Save');save.disabled=C.role!=='owner';save.onclick=async()=>{
 await run('save_route',{path:r.path,chat_enabled:chat.checked?'1':'0',popup_enabled:popup.checked?'1':'0',popup_seconds:secs.value,popup_text:msg.value,
 popup_color:color.value,popup_background:background.value,popup_font:font.value});
 C.rules[r.path]={chat_enabled:chat.checked,popup_enabled:popup.checked,popup_seconds:Number(secs.value),popup_text:msg.value,
 popup_color:color.value,popup_background:background.value,popup_font:Number(font.value)};notice('Saved '+r.path);
 };const td=elt('td');td.append(save);tr.append(td);body.append(tr);
 }
}
$('route-search').oninput=renderRoutes;
$('reload-routes').onclick=async()=>{const v=await run('routes',{});routeList=v.routes||[];renderRoutes();};
$('add-route').disabled=C.role!=='owner';
$('add-route').onclick=()=>{
 let path=$('new-route').value.trim();if(!path)return;
 path='/' + path.replace(/^\/+|\/+$/g,'') + '/';
 if(!/^\/[a-zA-Z0-9/_~.%-]*\/$/.test(path)||path==='/chatbot-admin/'){
   notice('Enter a valid local route such as /contact/');return;
 }
 if(!routeList.some(r=>r.path===path)) routeList.push({path,title:'Custom route',url:window.location.origin+path});
 $('route-search').value=path;renderRoutes();notice('Customize the new row and click Save');
};
loadSessions();
</script></body></html>
<?php
}
