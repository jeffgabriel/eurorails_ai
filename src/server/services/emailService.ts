import nodemailer from 'nodemailer';
import { Resend } from 'resend';

/**
 * Email service interface for sending verification emails
 */
export interface EmailService {
  sendVerificationEmail(email: string, username: string, verificationUrl: string): Promise<void>;
}

/**
 * Production email service using Resend API
 */
class ResendEmailService implements EmailService {
  private resend: Resend;
  private fromEmail: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY environment variable is required');
    }
    this.resend = new Resend(apiKey);
    this.fromEmail = process.env.EMAIL_FROM || 'noreply@eurorails.com';
  }

  async sendVerificationEmail(email: string, username: string, verificationUrl: string): Promise<void> {
    try {
      await this.resend.emails.send({
        from: this.fromEmail,
        to: email,
        subject: 'Verify your EuroRails email address',
        html: this.getVerificationEmailHtml(username, verificationUrl),
      });
      console.log(`[Email] Verification email sent to ${email}`);
    } catch (error) {
      console.error(`[Email] Failed to send verification email to ${email}:`, error);
      throw new Error('Failed to send verification email');
    }
  }

  private getVerificationEmailHtml(username: string, verificationUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Verify Your Email</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0;">Welcome to EuroRails!</h1>
  </div>
  
  <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">Hello <strong>${username}</strong>,</p>
    
    <p style="font-size: 16px;">Thank you for joining EuroRails! Please verify your email address by clicking the button below:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${verificationUrl}" 
         style="background: #667eea; color: white; padding: 14px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-size: 16px; font-weight: bold;">
        Verify Email Address
      </a>
    </div>
    
    <p style="font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
    <p style="font-size: 14px; color: #667eea; word-break: break-all;">${verificationUrl}</p>
    
    <p style="font-size: 14px; color: #666; margin-top: 30px;">
      <strong>This link will expire in 15 minutes.</strong>
    </p>
    
    <p style="font-size: 14px; color: #666;">
      If you didn't create an account with EuroRails, you can safely ignore this email.
    </p>
    
    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
    
    <p style="font-size: 12px; color: #999; text-align: center;">
      This email was sent by EuroRails. Please do not reply to this email.
    </p>
  </div>
</body>
</html>
    `.trim();
  }
}

/**
 * Development email service using MailDev (local SMTP server)
 */
class MailDevEmailService implements EmailService {
  private transporter: nodemailer.Transporter;
  private fromEmail: string;

  constructor() {
    const host = process.env.MAILDEV_SMTP_HOST || 'localhost';
    const port = parseInt(process.env.MAILDEV_SMTP_PORT || '1025', 10);
    
    this.transporter = nodemailer.createTransport({
      host,
      port,
      ignoreTLS: true,
    });
    
    this.fromEmail = process.env.EMAIL_FROM || 'noreply@eurorails.com';
  }

  async sendVerificationEmail(email: string, username: string, verificationUrl: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.fromEmail,
        to: email,
        subject: 'Verify your EuroRails email address',
        html: this.getVerificationEmailHtml(username, verificationUrl),
      });
      console.log(`[Email] Development verification email sent to ${email} (MailDev)`);
    } catch (error) {
      console.error(`[Email] Failed to send verification email to ${email}:`, error);
      throw new Error('Failed to send verification email');
    }
  }

  private getVerificationEmailHtml(username: string, verificationUrl: string): string {
    // Same HTML as ResendEmailService
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Verify Your Email</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0;">Welcome to EuroRails!</h1>
  </div>
  
  <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">Hello <strong>${username}</strong>,</p>
    
    <p style="font-size: 16px;">Thank you for joining EuroRails! Please verify your email address by clicking the button below:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${verificationUrl}" 
         style="background: #667eea; color: white; padding: 14px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-size: 16px; font-weight: bold;">
        Verify Email Address
      </a>
    </div>
    
    <p style="font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
    <p style="font-size: 14px; color: #667eea; word-break: break-all;">${verificationUrl}</p>
    
    <p style="font-size: 14px; color: #666; margin-top: 30px;">
      <strong>This link will expire in 15 minutes.</strong>
    </p>
    
    <p style="font-size: 14px; color: #666;">
      If you didn't create an account with EuroRails, you can safely ignore this email.
    </p>
    
    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
    
    <p style="font-size: 12px; color: #999; text-align: center;">
      This email was sent by EuroRails. Please do not reply to this email.
    </p>
  </div>
</body>
</html>
    `.trim();
  }
}

/**
 * Factory function to create appropriate email service based on environment
 */
export function createEmailService(): EmailService {
  const env = process.env.NODE_ENV;
  
  if (env === 'production') {
    console.log('[Email] Using Resend email service (production)');
    return new ResendEmailService();
  } else {
    console.log('[Email] Using MailDev email service (development)');
    return new MailDevEmailService();
  }
}

// Export singleton instance
export const emailService = createEmailService();
