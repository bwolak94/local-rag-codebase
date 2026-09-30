<?php

class OrderService {
    public function createOrder(int $userId): array {
        return ['id' => 1, 'user_id' => $userId];
    }

    public function cancelOrder(int $orderId): bool {
        return true;
    }
}

function formatPrice(float $amount): string {
    return number_format($amount, 2);
}
