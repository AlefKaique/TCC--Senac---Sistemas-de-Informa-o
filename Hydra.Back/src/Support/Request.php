<?php

namespace Hydra\Support;

final class Request
{
    /** @return array<string,mixed> */
    public static function json(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw === '') {
            return [];
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : [];
    }

    public static function method(): string
    {
        return $_SERVER['REQUEST_METHOD'] ?? 'GET';
    }
}
