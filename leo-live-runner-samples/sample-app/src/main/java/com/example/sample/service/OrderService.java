package com.example.sample.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;

@Service
public class OrderService {
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    // In-memory mock order storage
    private final Map<Long, String> orderStore = new HashMap<>();

    public OrderService() {
        orderStore.put(1001L, "STATUS_PENDING");
        orderStore.put(1002L, "STATUS_PENDING");
    }

    public String getOrderStatus(Long orderId) {
        return orderStore.getOrDefault(orderId, "NOT_FOUND");
    }

    public boolean updateOrderStatus(Long orderId, String newStatus) {
        log.info("OrderService: Updating order [{}] status to [{}]", orderId, newStatus);
        orderStore.put(orderId, newStatus);
        return true;
    }
}
