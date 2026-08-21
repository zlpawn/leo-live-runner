package com.example.sample;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootApplication
public class SampleApplication {

    public static void main(String[] args) {
        SpringApplication.run(SampleApplication.class, args);
    }

    @Bean
    public CommandLineRunner initDatabase(JdbcTemplate jdbcTemplate) {
        return args -> {
            jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS t_account (id BIGINT PRIMARY KEY, balance INT)");
            jdbcTemplate.execute("DELETE FROM t_account");
            jdbcTemplate.execute("INSERT INTO t_account (id, balance) VALUES (1, 1000)");
        };
    }
}
