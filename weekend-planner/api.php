<?php
/**
 * Weekend Planner – PHP persistence endpoint (for Apache/XAMPP/NetBeans setups).
 * The front end tries /api/plan (node server.js) first, then falls back to
 * this file. Same contract:
 *   GET  api.php            → current plan JSON
 *   PUT  api.php            → replace plan with JSON body
 *   POST api.php?reset=1    → reset to data/plan.default.json
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$dataDir = __DIR__ . '/data';
$planFile = $dataDir . '/plan.json';
$defaultFile = $dataDir . '/plan.default.json';

if (!is_dir($dataDir)) { mkdir($dataDir, 0775, true); }
if (!file_exists($planFile)) { copy($defaultFile, $planFile); }

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    readfile($planFile);
    exit;
}

if ($method === 'POST' && isset($_GET['reset'])) {
    copy($defaultFile, $planFile);
    readfile($planFile);
    exit;
}

if ($method === 'PUT' || $method === 'POST') {
    $body = file_get_contents('php://input');
    $parsed = json_decode($body, true);
    if (!is_array($parsed) || !isset($parsed['events']) || !is_array($parsed['events'])) {
        http_response_code(400);
        echo '{"error":"plan must be an object with an events array"}';
        exit;
    }
    if (file_exists($planFile)) { copy($planFile, $planFile . '.bak'); }
    file_put_contents($planFile, json_encode($parsed, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    echo '{"ok":true}';
    exit;
}

http_response_code(405);
echo '{"error":"method not allowed"}';
